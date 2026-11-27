"""Rotas HTTP.

Atrás do gateway, as de `/v1` ganham o prefixo `/api` (`/api/v1/reports/...`). As
de `/internal` não têm rota no gateway e exigem o token de uma conta de serviço.
"""

import asyncio
import logging
import uuid
from datetime import datetime
from http import HTTPStatus
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

from notification import tasks
from notification.api import problems
from notification.api.auth import User, require_role
from notification.clients.statements import StatementNotFound, StatementsUnavailable
from notification.dlq import requeue
from notification.ids import utcnow, uuid7
from notification.rabbit import topology
from notification.service import NotificationService

logger = logging.getLogger(__name__)

Service = Annotated[User, Depends(require_role("service"))]
Producer = Annotated[User, Depends(require_role("producer"))]
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
# Namespace do id do pedido de relatório quando vem com `Idempotency-Key`.
REPORT_NAMESPACE = uuid.UUID("0196a4c0-7a1e-7d6c-9c1e-5e1a7a0e4b21")

reports = APIRouter(prefix="/v1/reports", tags=["reports"])
internal = APIRouter(prefix="/internal/v1", tags=["internal"])
health = APIRouter(prefix="/health", tags=["health"])


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class StatementRequest(ApiModel):
    show_id: Annotated[str, StringConstraints(pattern=UUID_PATTERN)]


class StatementRequested(ApiModel):
    request_id: str
    show_id: str
    status: Literal["QUEUED"] = "QUEUED"
    requested_at: datetime


class RequeueRequest(ApiModel):
    queue: Literal["notifications.email.dlq", "tickets.render.dlq", "reports.generate.dlq"] = "notifications.email.dlq"
    limit: int | None = Field(default=None, ge=1, le=100_000)


class RequeueResponse(ApiModel):
    queue: str
    requeued: int
    skipped: int


class QueueDepth(ApiModel):
    queue: str
    messages: int


class DlqState(ApiModel):
    queues: list[QueueDepth]


def _service(request: Request) -> NotificationService:
    service: NotificationService = request.app.state.service
    if service.connection is None or service.publisher is None or service.monitor is None:
        raise problems.unavailable("O serviço ainda está subindo.")
    return service


@reports.post(
    "/statements",
    status_code=HTTPStatus.ACCEPTED,
    response_model=StatementRequested,
    response_model_by_alias=True,
)
async def request_statement(
    request: Request,
    user: Producer,
    body: StatementRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key", max_length=200)] = None,
) -> StatementRequested:
    """Pede o PDF do relatório financeiro do show, que chega por e-mail ao produtor.

    O relatório é lido agora no analytics (com o token da conta de serviço), e
    só o dono do show pode pedi-lo: show de outro produtor é 404, sem revelar
    que existe. O PDF é gerado pela fila `reports.generate` e enviado ao e-mail
    do produtor no Keycloak; a resposta é 202 assim que a tarefa está na fila.

    Não cria recurso, então a `Idempotency-Key` é opcional: com ela, o id do
    pedido de relatório sai da chave, e repetir o pedido manda um e-mail só.
    """
    service = _service(request)
    assert service.publisher is not None
    try:
        statement = await service.statements.get(body.show_id)
    except StatementNotFound:
        raise problems.not_found("Show") from None
    except StatementsUnavailable as error:
        logger.warning("Relatório indisponível no analytics", extra={"showId": body.show_id, "error": str(error)})
        raise problems.unavailable("O relatório não está disponível agora. Tente de novo em instantes.") from None
    if statement.producer_id != user.id:
        raise problems.not_found("Show")

    key = idempotency_key
    request_id = str(uuid.uuid5(REPORT_NAMESPACE, f"{user.id}:{key}")) if key else uuid7()
    requested_at = utcnow()
    task = tasks.GenerateStatement(
        request_id=request_id, producer_id=user.id, requested_at=requested_at, statement=statement
    )
    message_id = uuid7()
    try:
        await service.publisher.publish(
            topology.REPORTS,
            topology.STATEMENT_KEY,
            tasks.encode(task, message_id=message_id),
            message_id=message_id,
            message_type="GenerateStatement",
        )
    except Exception as error:
        raise problems.unavailable(f"Não foi possível falar com o RabbitMQ: {type(error).__name__}.") from error
    logger.info("Relatório financeiro pedido", extra={"reportId": request_id, "showId": body.show_id})
    return StatementRequested(request_id=request_id, show_id=body.show_id, requested_at=requested_at)


@internal.post("/dlq/requeue", response_model=RequeueResponse, response_model_by_alias=True)
async def requeue_dlq(
    request: Request, _: Service, body: Annotated[RequeueRequest | None, Body()] = None
) -> RequeueResponse:
    """Devolve as mensagens de uma DLQ para uma nova rodada de tentativas.

    Não cria recurso, então não exige `Idempotency-Key`: repetir só devolve o que
    tiver chegado à DLQ depois (ou nada).
    """
    service = _service(request)
    assert service.connection is not None
    assert service.publisher is not None
    assert service.monitor is not None
    target = body or RequeueRequest()
    try:
        result = await requeue(service.connection, service.publisher, target.queue, limit=target.limit)
    except Exception as error:
        raise problems.unavailable(f"Não foi possível falar com o RabbitMQ: {type(error).__name__}.") from error
    await service.monitor.refresh()
    return RequeueResponse(queue=result.queue, requeued=result.requeued, skipped=result.skipped)


@internal.get("/dlq", response_model=DlqState, response_model_by_alias=True)
async def dlq_state(request: Request, _: Service) -> DlqState:
    """Quantas mensagens há em cada DLQ agora."""
    service = _service(request)
    assert service.monitor is not None
    try:
        found = await service.monitor.refresh()
    except Exception as error:
        raise problems.unavailable(f"Não foi possível falar com o RabbitMQ: {type(error).__name__}.") from error
    return DlqState(queues=[QueueDepth(queue=queue, messages=count) for queue, count in found.items()])


@health.get("/live")
async def live() -> dict[str, str]:
    """O processo está vivo? Não olha dependências: reiniciar não as consertaria."""
    return {"status": "ok"}


@health.get("/ready")
async def ready(request: Request) -> JSONResponse:
    """Pode trabalhar? RabbitMQ conectado e consumidor do Kafka rodando.

    O Redis aparece no resultado mas não derruba a prontidão: sem ele, o serviço
    segue sem deduplicação (veja `dedupe.py`).
    """
    service: NotificationService | None = getattr(request.app.state, "service", None)
    checks: dict[str, str] = {"rabbitmq": "down", "kafkaConsumer": "down", "redis": "down"}
    if service is not None:
        checks["rabbitmq"] = "up" if service.rabbitmq_connected else "down"
        checks["kafkaConsumer"] = "up" if service.kafka_consuming else "down"
        if service.dedupe is not None:
            try:
                checks["redis"] = "up" if await asyncio.wait_for(service.dedupe.ping(), timeout=1.0) else "down"
            except TimeoutError:
                checks["redis"] = "down"
    healthy = checks["rabbitmq"] == "up" and checks["kafkaConsumer"] == "up"
    return JSONResponse(
        {"status": "ok" if healthy else "error", "checks": checks},
        status_code=HTTPStatus.OK if healthy else HTTPStatus.SERVICE_UNAVAILABLE,
    )

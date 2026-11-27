"""Rotas HTTP. As de `/internal` não têm rota no gateway e exigem o token de uma conta de serviço."""

import asyncio
from http import HTTPStatus
from typing import Annotated, Literal

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from notification.api import problems
from notification.api.auth import User, require_role
from notification.dlq import requeue
from notification.service import NotificationService

Service = Annotated[User, Depends(require_role("service"))]

internal = APIRouter(prefix="/internal/v1", tags=["internal"])
health = APIRouter(prefix="/health", tags=["health"])


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class RequeueRequest(ApiModel):
    queue: Literal["notifications.email.dlq", "tickets.render.dlq"] = "notifications.email.dlq"
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

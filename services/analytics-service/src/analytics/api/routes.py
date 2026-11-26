"""Rotas HTTP. Atrás do gateway, as de `/v1` ganham o prefixo `/api`; as de `/internal` não têm rota no gateway."""

import asyncio
import logging
from http import HTTPStatus
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Path, Query, Request, Response
from fastapi.responses import JSONResponse

from analytics.api import problems, schemas, views
from analytics.api.auth import User, require_role
from analytics.api.pagination import InvalidCursor, decode_cursor, encode_cursor
from analytics.replay import BackgroundReplays
from analytics.store.generations import Generation, GenerationRegistry, ReplayInProgress
from analytics.store.read_models import ReadModels
from analytics.supervisor import LiveSupervisor

logger = logging.getLogger(__name__)

UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
ShowId = Annotated[str, Path(alias="showId", pattern=UUID_PATTERN)]
Producer = Annotated[User, Depends(require_role("producer"))]
Service = Annotated[User, Depends(require_role("service"))]

Doc = dict[str, Any]

analytics = APIRouter(prefix="/v1/analytics", tags=["analytics"])
internal = APIRouter(prefix="/internal/v1", tags=["internal"])
health = APIRouter(prefix="/health", tags=["health"])


async def active_models(request: Request) -> ReadModels:
    """Coleções da geração ativa, lida do ponteiro a cada requisição.

    Depois de um replay, a requisição seguinte já lê a geração nova; a antiga só
    é apagada depois da carência, então uma leitura em andamento termina nela.
    """
    registry: GenerationRegistry = request.app.state.registry
    generation = await registry.active_generation()
    if generation is None:
        raise problems.unavailable("Os read models ainda estão sendo criados.")
    return ReadModels.of(registry.db, generation)


Models = Annotated[ReadModels, Depends(active_models)]


async def _owned_show(models: ReadModels, show_id: str, user: User) -> Doc:
    """O show, se pertence ao produtor. Show de outro produtor é 404: não revela que existe."""
    show = await models.shows.find_one({"_id": show_id})
    if show is None or show.get("producerId") != user.id:
        raise problems.not_found("Show")
    return show


@analytics.get("/shows/{showId}/sales", response_model=schemas.ShowSales)
async def show_sales(show_id: ShowId, user: Producer, models: Models) -> schemas.ShowSales:
    show = await _owned_show(models, show_id, user)
    hourly, lots = await asyncio.gather(
        models.sales.find({"showId": show_id}).sort("hour", 1).to_list(None),
        models.lots.find({"showId": show_id}).to_list(None),
    )
    return views.sales(show, hourly, lots)


@analytics.get("/shows/{showId}/statement", response_model=schemas.Statement)
async def show_statement(show_id: ShowId, user: Producer, models: Models) -> schemas.Statement:
    show = await _owned_show(models, show_id, user)
    return views.statement(show, await models.statements.find_one({"_id": show_id}))


@analytics.get("/shows/{showId}/orders", response_model=schemas.OrderPage)
async def show_orders(
    show_id: ShowId,
    user: Producer,
    models: Models,
    status: Annotated[Literal["PENDING", "CONFIRMED", "CANCELLED"] | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    cursor: Annotated[str | None, Query(max_length=200)] = None,
) -> schemas.OrderPage:
    await _owned_show(models, show_id, user)
    query: Doc = {"showId": show_id}
    if status is not None:
        query["status"] = status
    if cursor is not None:
        try:
            query["_id"] = {"$lt": decode_cursor(cursor)}
        except InvalidCursor:
            raise problems.validation([{"field": "cursor", "message": "Cursor inválido"}]) from None
    found = await models.orders.find(query).sort("_id", -1).limit(limit + 1).to_list(None)
    page = found[:limit]
    return schemas.OrderPage(
        items=[views.order(doc) for doc in page],
        next_cursor=encode_cursor(page[-1]["_id"]) if len(found) > limit else None,
    )


def _replay(generation: Generation) -> schemas.Replay:
    return schemas.Replay(
        generation=generation.number,
        status=generation.status,
        started_at=generation.created_at,
        switched_at=generation.switched_at,
        finished_at=generation.finished_at,
        events_applied=generation.events_applied,
        end_offsets=[schemas.PartitionOffset.model_validate(offset) for offset in generation.end_offsets],
        error=generation.error,
    )


@internal.post("/replay", status_code=HTTPStatus.ACCEPTED, response_model=schemas.Replay)
async def start_replay(request: Request, response: Response, _: Service) -> schemas.Replay:
    """Reconstrói os read models do zero, numa geração nova, sem parar a leitura.

    Não exige `Idempotency-Key`: enquanto um replay roda, outro pedido recebe 409,
    e um replay repetido depois só reconstrói de novo o mesmo resultado.
    """
    replays: BackgroundReplays = request.app.state.replays
    registry: GenerationRegistry = request.app.state.registry
    try:
        generation = await replays.trigger()
    except ReplayInProgress as error:
        raise problems.ProblemError(
            HTTPStatus.CONFLICT,
            "replay-in-progress",
            "Replay em andamento",
            "Já existe um replay em andamento. Acompanhe-o e tente de novo quando terminar.",
            extra={"generation": error.generation} if error.generation else None,
        ) from None
    found = await registry.get(generation)
    assert found is not None
    response.headers["Location"] = f"/internal/v1/replay/{generation}"
    return _replay(found)


@internal.get("/replay/{generation}", response_model=schemas.Replay)
async def get_replay(request: Request, generation: Annotated[int, Path(ge=1)], _: Service) -> schemas.Replay:
    registry: GenerationRegistry = request.app.state.registry
    found = await registry.get(generation)
    if found is None:
        raise problems.not_found("Replay")
    return _replay(found)


@health.get("/live")
async def live() -> dict[str, str]:
    """O processo está vivo? Não olha dependências: reiniciar não as consertaria."""
    return {"status": "ok"}


@health.get("/ready")
async def ready(request: Request) -> JSONResponse:
    """Pode atender? MongoDB responde e o consumidor ao vivo está rodando."""
    registry: GenerationRegistry = request.app.state.registry
    supervisor: LiveSupervisor = request.app.state.supervisor
    checks: dict[str, str] = {}
    try:
        await asyncio.wait_for(registry.db.command("ping"), timeout=1.0)
        checks["mongodb"] = "up"
    except Exception:
        checks["mongodb"] = "down"
    checks["kafkaConsumer"] = "up" if supervisor.consuming else "down"
    healthy = all(value == "up" for value in checks.values())
    return JSONResponse(
        {"status": "ok" if healthy else "error", "checks": checks, "generation": supervisor.generation},
        status_code=HTTPStatus.OK if healthy else HTTPStatus.SERVICE_UNAVAILABLE,
    )

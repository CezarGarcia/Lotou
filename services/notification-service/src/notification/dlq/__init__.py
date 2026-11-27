"""As DLQs: profundidade (métrica `notifications_dlq_depth`) e requeue para uma nova rodada.

Uma mensagem só chega a uma DLQ depois de esgotar as tentativas, ou quando
repetir não adiantaria (tarefa ilegível, show que não existe). Ela fica lá, durável,
até alguém olhar o motivo (`x-error`), corrigir a causa e devolvê-la:

- `POST /internal/v1/dlq/requeue` (papel `service`), ou
- `python -m notification.dlq requeue` (`make requeue-notifications` na raiz).

O requeue tira da DLQ só o que havia nela no começo (não entra em laço com uma
mensagem que falhe de novo e volte), publica cada mensagem de volta no exchange
de origem, com `x-attempt: 1` (uma rodada nova de 4 tentativas), espera a
confirmação do broker e só então a tira da DLQ.
"""

import asyncio
import logging
from dataclasses import dataclass

from aio_pika.abc import AbstractRobustChannel, AbstractRobustConnection
from opentelemetry import metrics, trace
from opentelemetry.metrics import CallbackOptions, Observation

from notification import tasks
from notification.ids import utcnow, uuid7
from notification.rabbit import topology
from notification.rabbit.dead_letter import ERROR_HEADER, FAILED_AT_HEADER, ORIGINAL_QUEUE_HEADER
from notification.rabbit.publisher import Publisher, carried_headers
from notification.rabbit.retry import ATTEMPT_HEADER

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("notification-service")
meter = metrics.get_meter("notification-service")

REQUEUED_AT_HEADER = "x-requeued-at"
REQUEUE_COUNT_HEADER = "x-requeue-count"


@dataclass(frozen=True)
class RequeueResult:
    queue: str
    requeued: int
    # Mensagens que não puderam voltar (corpo ilegível): ficam na DLQ.
    skipped: int


class UnknownQueue(ValueError):
    pass


def _routing_key(queue: str, body: bytes) -> str:
    if queue == topology.RENDER_DLQ:
        return topology.RENDER_KEY
    if queue == topology.REPORTS_DLQ:
        return topology.STATEMENT_KEY
    _, task = tasks.decode(body, tasks.SendEmail)
    return tasks.routing_key(task.email)


async def requeue(
    connection: AbstractRobustConnection, publisher: Publisher, queue: str, *, limit: int | None = None
) -> RequeueResult:
    route = topology.REQUEUE_ROUTES.get(queue)
    if route is None:
        raise UnknownQueue(f"{queue} não é uma DLQ do notification-service")
    with tracer.start_as_current_span("dlq requeue", attributes={"messaging.destination.name": queue}) as span:
        channel = await connection.channel()
        try:
            declared = await channel.declare_queue(queue, passive=True, robust=False)
            available = int(declared.declaration_result.message_count or 0)
            budget = available if limit is None else min(available, limit)
            requeued = skipped = 0
            # Ilegíveis voltam para a DLQ só no fim, para não serem lidas de novo nesta rodada.
            unreadable = []
            for _ in range(budget):
                message = await declared.get(no_ack=False, fail=False)
                if message is None:
                    break
                try:
                    key = _routing_key(queue, message.body)
                except tasks.InvalidTask:
                    unreadable.append(message)
                    skipped += 1
                    continue
                headers = {
                    name: value
                    for name, value in carried_headers(message.headers).items()
                    if name not in (ERROR_HEADER, FAILED_AT_HEADER, ORIGINAL_QUEUE_HEADER)
                }
                previous = headers.get(REQUEUE_COUNT_HEADER)
                headers[ATTEMPT_HEADER] = 1
                headers[REQUEUE_COUNT_HEADER] = (previous if isinstance(previous, int) else 0) + 1
                headers[REQUEUED_AT_HEADER] = utcnow().isoformat()
                await publisher.publish(
                    route.exchange,
                    key,
                    message.body,
                    message_id=message.message_id or uuid7(),
                    message_type=message.type or "unknown",
                    headers=headers,
                    priority=message.priority,
                )
                await message.ack()
                requeued += 1
            for message in unreadable:
                await message.nack(requeue=True)
        finally:
            await channel.close()
        span.set_attribute("lotou.dlq.requeued", requeued)
        span.set_attribute("lotou.dlq.skipped", skipped)
    logger.info("Mensagens devolvidas da DLQ", extra={"queue": queue, "requeued": requeued, "skipped": skipped})
    return RequeueResult(queue=queue, requeued=requeued, skipped=skipped)


async def depths(channel: AbstractRobustChannel) -> dict[str, int]:
    return {queue: await topology.depth(channel, queue) for queue in topology.DLQS}


class DlqMonitor:
    """Lê a profundidade das DLQs de tempos em tempos, para a métrica e o health check.

    O callback de um gauge do OpenTelemetry é síncrono, e a leitura no broker
    não é: uma tarefa lê (declaração passiva) a cada `DLQ_POLL_SECONDS` e o gauge
    devolve o último valor lido. O alerta "DLQ" do documento é
    `notifications_dlq_depth > 0`.
    """

    def __init__(self, connection: AbstractRobustConnection, *, interval: float) -> None:
        self._connection = connection
        self._interval = interval
        self._channel: AbstractRobustChannel | None = None
        self._lock = asyncio.Lock()
        self.last: dict[str, int] = {}
        _MONITORS.append(self)

    async def refresh(self) -> dict[str, int]:
        async with self._lock:
            if self._channel is None or self._channel.is_closed:
                self._channel = await self._connection.channel()
            self.last = await depths(self._channel)
            return dict(self.last)

    async def run(self) -> None:
        while True:
            try:
                await self.refresh()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("Não foi possível ler a profundidade das DLQs", exc_info=True)
            await asyncio.sleep(self._interval)

    async def close(self) -> None:
        if self in _MONITORS:
            _MONITORS.remove(self)
        async with self._lock:
            if self._channel is not None and not self._channel.is_closed:
                await self._channel.close()


_MONITORS: list[DlqMonitor] = []


def _observe(_: CallbackOptions) -> list[Observation]:
    if not _MONITORS:
        return []
    return [Observation(depth, {"queue": queue}) for queue, depth in _MONITORS[-1].last.items()]


meter.create_observable_gauge(
    "notifications_dlq_depth",
    callbacks=[_observe],
    unit="{message}",
    description="Mensagens em cada DLQ (notifications.email.dlq, tickets.render.dlq, reports.generate.dlq); "
    "acima de zero é alerta",
)

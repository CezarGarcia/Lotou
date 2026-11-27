"""Consumidor de `order.events`: transforma fatos do pedido em tarefas no RabbitMQ.

| Evento | Tarefa |
| --- | --- |
| `TicketsIssued` | `RenderTickets` em `tickets` (`render`): gerar o PDF |
| `OrderCancelled` | `SendEmail` em `notifications` (`email.order.cancelled`) |
| outros | ignorados |

Ao menos uma vez, sem perder nada: o offset de uma partição só é confirmado
depois que o RabbitMQ confirmou cada tarefa do lote (publisher confirms). Uma
queda no meio faz o Kafka entregar de novo, e a marca `notification:event:{id}`
no Redis descarta o que já tinha virado tarefa.

Falhas:

- mensagem fora do contrato: repetir não muda nada, vai direto para
  `order.events.dlt` e o consumidor segue;
- RabbitMQ fora (ou sem confirmar): espera e tenta de novo sem limite, sem
  confirmar o offset. Nada se perde; o lag do consumer group sobe e volta a
  zero quando o broker volta.

`isolation_level=read_committed`, como no analytics: mensagem de transação
abortada de um produtor transacional nunca vira e-mail.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from contextlib import AbstractContextManager

from aiokafka import AIOKafkaConsumer, TopicPartition
from aiokafka.errors import CommitFailedError, IllegalStateError, KafkaError
from aiokafka.structs import ConsumerRecord
from opentelemetry import metrics, propagate, trace
from opentelemetry.trace import SpanKind

from notification import tasks
from notification.config import Settings
from notification.contracts import TOPIC_ORDERS, ContractError, Event, OrderCancelled, TicketsIssued, parse, peek_type
from notification.dedupe import Dedupe, event_key
from notification.ids import uuid7
from notification.kafka.dead_letter import DeadLetterPublisher
from notification.rabbit import topology
from notification.rabbit.publisher import Publisher
from notification.rabbit.retry import ATTEMPT_HEADER

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("notification-service")
meter = metrics.get_meter("notification-service")

events_counter = meter.create_counter(
    "notification_events",
    unit="{event}",
    description="Mensagens de order.events lidas, por tipo e resultado (queued, duplicate, ignored, dead_lettered)",
)

type Record = ConsumerRecord  # ConsumerRecord[bytes, bytes] na prática


class ConsumerStopped(Exception):
    """O consumidor foi parado no meio de uma espera; o lote não é confirmado."""


def _backoff(attempt: int, *, base: float = 0.2, cap: float = 10.0) -> float:
    return float(min(cap, base * 2 ** (attempt - 1)))


class OrderEventsConsumer:
    def __init__(
        self,
        *,
        settings: Settings,
        publisher: Publisher,
        dedupe: Dedupe,
        dead_letter: DeadLetterPublisher,
        retry_base_seconds: float = 0.2,
    ) -> None:
        self.group_id = settings.kafka_group_id
        self.ready = asyncio.Event()
        self._publisher = publisher
        self._dedupe = dedupe
        self._dead_letter = dead_letter
        self._batch_size = settings.consumer_batch_size
        self._retry_base = retry_base_seconds
        self._stopping = asyncio.Event()
        self._started = False
        self._consumer = AIOKafkaConsumer(
            TOPIC_ORDERS,
            bootstrap_servers=settings.kafka_brokers,
            group_id=settings.kafka_group_id,
            client_id="notification-service",
            enable_auto_commit=False,
            auto_offset_reset=settings.kafka_auto_offset_reset,
            isolation_level="read_committed",
        )

    async def start(self) -> None:
        await self._consumer.start()
        self._started = True

    def request_stop(self) -> None:
        self._stopping.set()

    async def close(self) -> None:
        """Sai do consumer group. Chame depois que `run` terminou. Pode repetir."""
        self._stopping.set()
        if self._started:
            self._started = False
            await self._consumer.stop()

    async def run(self) -> None:
        try:
            while not self._stopping.is_set():
                batches: dict[TopicPartition, list[Record]] = await self._consumer.getmany(
                    timeout_ms=500, max_records=self._batch_size
                )
                if not self.ready.is_set():
                    await self._resolve_positions()
                for tp, records in batches.items():
                    if self._stopping.is_set():
                        return
                    await self._process(tp, records)
        except ConsumerStopped:
            pass

    async def _resolve_positions(self) -> None:
        """Pronto quando tem partições e sabe de onde ler cada uma.

        Partição sem offset confirmado (consumer group novo) ganha um agora, na
        posição em que o consumidor começou. Sem isso, um serviço que subiu,
        não recebeu nada e caiu voltaria com `latest` e pularia o que foi
        publicado enquanto estava fora.
        """
        assignment = self._consumer.assignment()
        if not assignment:
            return
        missing: dict[TopicPartition, int] = {}
        for tp in assignment:
            position = await self._consumer.position(tp)
            if await self._consumer.committed(tp) is None:
                missing[tp] = position
        if missing:
            await self._commit(missing)
        self.ready.set()

    # ------------------------------------------------------------- lote

    async def _process(self, tp: TopicPartition, records: Sequence[Record]) -> None:
        for record in records:
            try:
                event = parse(record.value)
            except ContractError as error:
                await self._send_to_dlt(record, error)
                continue
            if event is None:
                self._count(peek_type(record.value), "ignored")
                continue
            with _record_span(record, event, self.group_id):
                self._count(event.type, await self._handle(event))
        await self._commit({tp: records[-1].offset + 1})

    async def _handle(self, event: Event) -> str:
        key = event_key(event.event_id)
        if await self._dedupe.seen(key):
            logger.info("Evento repetido ignorado", extra={"eventId": event.event_id, "eventType": event.type})
            return "duplicate"
        await self._retrying(lambda: self._publish_task(event))
        await self._dedupe.mark(key)
        return "queued"

    async def _publish_task(self, event: Event) -> None:
        payload = event.payload
        if isinstance(payload, TicketsIssued):
            render = tasks.RenderTickets(
                source_event_id=event.event_id,
                order_id=payload.order_id,
                buyer_id=payload.buyer_id,
                show_id=payload.show_id,
                issued_at=payload.issued_at,
                tickets=[
                    tasks.TicketToRender(
                        ticket_id=ticket.ticket_id, sector_name=ticket.sector_name, seat=ticket.seat, code=ticket.code
                    )
                    for ticket in payload.tickets
                ],
            )
            message_id = uuid7()
            await self._publisher.publish(
                topology.TICKETS,
                topology.RENDER_KEY,
                tasks.encode(render, message_id=message_id),
                message_id=message_id,
                message_type="RenderTickets",
            )
        elif isinstance(payload, OrderCancelled):
            email = tasks.CancellationEmail(
                source_event_id=event.event_id,
                buyer_id=payload.buyer_id,
                order_id=payload.order_id,
                show_id=payload.show_id,
                total_cents=payload.total_cents,
                reason=payload.reason,
                cancelled_at=payload.cancelled_at,
            )
            message_id = uuid7()
            await self._publisher.publish(
                topology.NOTIFICATIONS,
                tasks.routing_key(email),
                tasks.encode(tasks.SendEmail(email=email), message_id=message_id),
                message_id=message_id,
                message_type="SendEmail",
                headers={ATTEMPT_HEADER: 1},
                priority=tasks.priority(email),
            )

    # ---------------------------------------------------- infraestrutura

    async def _retrying(self, operation: Callable[[], Awaitable[None]]) -> None:
        attempt = 0
        while True:
            try:
                await operation()
                return
            except asyncio.CancelledError:
                raise
            except Exception as error:
                attempt += 1
                logger.warning(
                    "RabbitMQ indisponível; tentando publicar de novo",
                    extra={"attempt": attempt, "error": f"{type(error).__name__}: {error}"},
                )
                await self._sleep(_backoff(attempt, base=self._retry_base))

    async def _send_to_dlt(self, record: Record, error: BaseException) -> None:
        attempt = 0
        while True:
            try:
                await self._dead_letter.publish(record, group_id=self.group_id, error=error)
                break
            except KafkaError:
                attempt += 1
                logger.warning("Falha ao publicar na DLT; tentando de novo", extra={"attempt": attempt}, exc_info=True)
                await self._sleep(_backoff(attempt, base=self._retry_base))
        self._count(peek_type(record.value), "dead_lettered")

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
        except TimeoutError:
            return
        raise ConsumerStopped

    async def _commit(self, offsets: dict[TopicPartition, int]) -> None:
        try:
            await self._consumer.commit(offsets)
        except (CommitFailedError, IllegalStateError) as error:
            # A partição foi para outro membro do grupo no meio do lote. Ele vai
            # receber as mensagens de novo, e a marca no Redis descarta o que já
            # virou tarefa aqui.
            logger.warning("Commit recusado por rebalanceamento", extra={"error": str(error)})

    def _count(self, event_type: str, result: str) -> None:
        events_counter.add(1, {"type": event_type, "result": result})


def _record_span(record: Record, event: Event, group_id: str) -> AbstractContextManager[trace.Span]:
    """Span de processamento ligado ao trace de quem publicou (`traceparent`)."""
    carrier = {key: value.decode("utf-8", "replace") for key, value in record.headers}
    return tracer.start_as_current_span(
        f"{record.topic} process",
        context=propagate.extract(carrier),
        kind=SpanKind.CONSUMER,
        attributes={
            "messaging.system": "kafka",
            "messaging.operation.type": "process",
            "messaging.destination.name": record.topic,
            "messaging.destination.partition.id": str(record.partition),
            "messaging.kafka.offset": record.offset,
            "messaging.kafka.message.key": (record.key or b"").decode("utf-8", "replace"),
            "messaging.consumer.group.name": group_id,
            "messaging.message.id": event.event_id,
            "lotou.event.type": event.type,
        },
    )

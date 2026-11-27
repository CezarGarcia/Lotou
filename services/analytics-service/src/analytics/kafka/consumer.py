"""Consumidor dos tópicos de uma geração dos read models.

Lê `shows.catalog`, `order.events` e `inventory.events` com commit manual: o
offset só é confirmado depois que a transação do MongoDB com o efeito
terminou. Uma queda entre as duas coisas faz o Kafka entregar de novo, e o
`processed_events` descarta a repetição (ao menos uma vez + idempotência).

Cada lote de uma partição é aplicado numa transação só. Se o lote falha por um
erro que não é de infraestrutura, as mensagens são aplicadas uma a uma, para
isolar a que tem problema. Falhas:

- mensagem fora do contrato (JSON inválido, campo faltando): repetir não muda
  nada, vai direto para `<tópico>.dlt`;
- erro ao aplicar: `CONSUMER_MAX_ATTEMPTS` tentativas com espera crescente e
  depois a DLT, e o consumidor segue;
- infraestrutura (MongoDB fora, eleição no replica set): espera e tenta de novo
  sem limite. Mandar para a DLT aqui perderia eventos bons; o lag sobe e o
  alerta de consumer lag avisa.

O consumidor ao vivo recebe o `feed` do painel: as entradas de atividade de cada
transação vão para o Redis depois que ela confirma (`analytics.live.activity`).
O do replay não recebe, e não escreve no feed.
"""

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from contextlib import AbstractContextManager
from typing import Any

from aiokafka import AIOKafkaConsumer, TopicPartition
from aiokafka.errors import CommitFailedError, IllegalStateError, KafkaError
from aiokafka.structs import ConsumerRecord
from opentelemetry import metrics, propagate, trace
from opentelemetry.trace import SpanKind
from pymongo.asynchronous.client_session import AsyncClientSession
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.asynchronous.mongo_client import AsyncMongoClient
from pymongo.errors import ConnectionFailure, ExecutionTimeout, PyMongoError

from analytics.config import Settings
from analytics.contracts import TOPICS, ContractError, Event, parse
from analytics.kafka import admin
from analytics.kafka.dead_letter import DeadLetterPublisher
from analytics.live.activity import ActivityEntry, ActivityFeed
from analytics.projection import Outcome, Projector, Source

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("analytics-service")
meter = metrics.get_meter("analytics-service")

events_counter = meter.create_counter(
    "analytics_events",
    unit="{event}",
    description="Mensagens lidas pelo analytics, por tópico, tipo e resultado",
)
batch_duration = meter.create_histogram(
    "analytics_batch_duration",
    unit="s",
    description="Tempo para aplicar um lote de uma partição (transação inclusa)",
)

Doc = dict[str, Any]
# O aiokafka não tem tipos: ConsumerRecord[bytes, bytes] na prática.
type Record = ConsumerRecord

DEAD_LETTERED = "dead_lettered"
IGNORED = "ignored"


class ConsumerStopped(Exception):
    """O consumidor foi parado no meio de uma espera; o lote não é confirmado."""


def is_infrastructure_error(error: BaseException) -> bool:
    """Falha que não é culpa da mensagem: tentar de novo mais tarde resolve."""
    if isinstance(error, ConnectionFailure | ExecutionTimeout):
        return True
    if isinstance(error, PyMongoError):
        return error.has_error_label("TransientTransactionError") or error.has_error_label("RetryableWriteError")
    return False


def _backoff(attempt: int, *, base: float = 0.2, cap: float = 10.0) -> float:
    return float(min(cap, base * 2 ** (attempt - 1)))


class GenerationConsumer:
    def __init__(
        self,
        *,
        settings: Settings,
        client: AsyncMongoClient[Doc],
        db: AsyncDatabase[Doc],
        generation: int,
        group_id: str,
        dead_letter: DeadLetterPublisher,
        role: str,
        feed: ActivityFeed | None = None,
        retry_base_seconds: float = 0.2,
    ) -> None:
        self.generation = generation
        self.group_id = group_id
        self.role = role
        self.events_applied = 0
        self._client = client
        self._projector = Projector(db, generation)
        self._dead_letter = dead_letter
        self._feed = feed
        self._batch_size = settings.consumer_batch_size
        self._max_attempts = settings.consumer_max_attempts
        self._retry_base = retry_base_seconds
        self._bootstrap_servers = settings.kafka_brokers
        self._stopping = asyncio.Event()
        self._closed = False
        self._consumer = AIOKafkaConsumer(
            *TOPICS,
            bootstrap_servers=settings.kafka_brokers,
            group_id=group_id,
            client_id=f"analytics-service-{role}",
            enable_auto_commit=False,
            auto_offset_reset="earliest",
            isolation_level="read_committed",
        )

    async def start(self) -> None:
        # Confere os tópicos antes: sem isso, o aiokafka falha com um erro que não diz qual falta.
        await admin.partitions(self._bootstrap_servers, TOPICS)
        await self._consumer.start()

    def request_stop(self) -> None:
        self._stopping.set()

    async def close(self) -> None:
        """Sai do consumer group. Chame depois que `run` terminou. Pode repetir."""
        self._stopping.set()
        if not self._closed:
            self._closed = True
            await self._consumer.stop()

    async def end_offsets(self) -> dict[TopicPartition, int]:
        """Fim de cada partição agora: até onde o replay precisa chegar.

        Com `read_committed`, é o último offset estável: uma transação aberta de
        um produtor não faz o replay esperar por ela.
        """
        partitions = await admin.partitions(self._bootstrap_servers, TOPICS)
        offsets: dict[TopicPartition, int] = await self._consumer.end_offsets(partitions)
        return offsets

    async def run(
        self,
        *,
        until: Mapping[TopicPartition, int] | None = None,
        on_progress: Callable[[], Awaitable[None]] | None = None,
    ) -> bool:
        """Consome até `request_stop` ou, com `until`, até alcançar esses offsets.

        Devolve `True` quando alcançou `until` (e confirmou as posições no
        consumer group, para quem continuar dali); `False` quando foi parado.
        """
        try:
            while not self._stopping.is_set():
                batches: dict[TopicPartition, list[Record]] = await self._consumer.getmany(
                    timeout_ms=500, max_records=self._batch_size
                )
                for tp, records in batches.items():
                    if self._stopping.is_set():
                        return False
                    await self._process(tp, records)
                if on_progress is not None:
                    await on_progress()
                if until is not None and await self._caught_up(until):
                    await self._commit_positions()
                    return True
        except ConsumerStopped:
            pass
        return False

    # ------------------------------------------------------------- lote

    async def _process(self, tp: TopicPartition, records: Sequence[Record]) -> None:
        started = time.perf_counter()
        parsed: list[tuple[Record, Event]] = []
        for record in records:
            try:
                event = parse(record.value)
            except ContractError as error:
                await self._send_to_dlt(record, error)
                continue
            if event is None:
                self._count(record.topic, _peek_type(record), IGNORED)
                continue
            parsed.append((record, event))

        if parsed:
            with tracer.start_as_current_span(
                "analytics project batch",
                attributes={
                    "messaging.system": "kafka",
                    "messaging.destination.name": tp.topic,
                    "messaging.destination.partition.id": str(tp.partition),
                    "messaging.batch.message_count": len(parsed),
                    "messaging.consumer.group.name": self.group_id,
                    "lotou.analytics.generation": self.generation,
                },
            ):
                try:
                    outcomes = await self._retrying_infrastructure(lambda: self._apply(parsed))
                except ConsumerStopped:
                    raise
                except Exception:
                    logger.warning(
                        "Lote falhou; aplicando as mensagens uma a uma",
                        extra={"topic": tp.topic, "partition": tp.partition, "size": len(parsed)},
                        exc_info=True,
                    )
                    outcomes = [await self._apply_alone(record, event) for record, event in parsed]
            for (record, event), outcome in zip(parsed, outcomes, strict=True):
                self._count(record.topic, event.type, outcome)
                if outcome == Outcome.APPLIED:
                    self.events_applied += 1

        await self._commit({tp: records[-1].offset + 1})
        batch_duration.record(time.perf_counter() - started, {"topic": tp.topic, "consumer": self.role})

    async def _apply(self, parsed: Sequence[tuple[Record, Event]]) -> list[str]:
        # A transação pode rodar mais de uma vez (conflito): valem as entradas da que confirmou.
        activity: list[ActivityEntry] = []
        async with self._client.start_session() as session:

            async def transaction(s: AsyncClientSession) -> list[str]:
                activity.clear()
                feed = activity if self._feed is not None else None
                outcomes: list[str] = []
                for record, event in parsed:
                    with _record_span(record, event, self.group_id):
                        source = Source(record.topic, record.partition, record.offset)
                        outcomes.append(await self._projector.apply(event, source, s, feed))
                return outcomes

            outcomes = await session.with_transaction(transaction)
        if self._feed is not None and activity:
            await self._feed.publish(activity)
        return outcomes

    async def _apply_alone(self, record: Record, event: Event) -> str:
        last_error: Exception | None = None
        for attempt in range(1, self._max_attempts + 1):
            try:
                outcomes = await self._retrying_infrastructure(lambda: self._apply([(record, event)]))
                return outcomes[0]
            except ConsumerStopped:
                raise
            except Exception as error:
                last_error = error
                logger.warning(
                    "Falha ao aplicar a mensagem",
                    extra={
                        "topic": record.topic,
                        "partition": record.partition,
                        "offset": record.offset,
                        "eventId": event.event_id,
                        "eventType": event.type,
                        "attempt": attempt,
                    },
                    exc_info=True,
                )
                if attempt < self._max_attempts:
                    await self._sleep(_backoff(attempt, base=self._retry_base))
        assert last_error is not None
        await self._send_to_dlt(record, last_error, event_type=event.type)
        return DEAD_LETTERED

    # ---------------------------------------------------- infraestrutura

    async def _retrying_infrastructure[T](self, operation: Callable[[], Awaitable[T]]) -> T:
        attempt = 0
        while True:
            try:
                return await operation()
            except Exception as error:
                if not is_infrastructure_error(error):
                    raise
                attempt += 1
                logger.warning(
                    "MongoDB indisponível; tentando de novo",
                    extra={"attempt": attempt, "error": f"{type(error).__name__}: {error}"},
                )
                await self._sleep(_backoff(attempt, base=self._retry_base))

    async def _send_to_dlt(self, record: Record, error: BaseException, *, event_type: str | None = None) -> None:
        attempt = 0
        while True:
            try:
                await self._dead_letter.publish(record, group_id=self.group_id, error=error)
                break
            except KafkaError:
                # Sem a DLT, a mensagem não pode ser descartada: espera o Kafka voltar.
                attempt += 1
                logger.warning("Falha ao publicar na DLT; tentando de novo", extra={"attempt": attempt}, exc_info=True)
                await self._sleep(_backoff(attempt, base=self._retry_base))
        self._count(record.topic, event_type or _peek_type(record), DEAD_LETTERED)

    async def _sleep(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
        except TimeoutError:
            return
        raise ConsumerStopped

    # ----------------------------------------------------------- offsets

    async def _commit(self, offsets: dict[TopicPartition, int]) -> None:
        try:
            await self._consumer.commit(offsets)
        except (CommitFailedError, IllegalStateError) as error:
            # A partição foi para outro membro do grupo no meio do lote. Ele vai
            # receber as mensagens de novo, e o processed_events descarta o que
            # já foi aplicado aqui.
            logger.warning("Commit recusado por rebalanceamento", extra={"error": str(error)})

    async def _caught_up(self, until: Mapping[TopicPartition, int]) -> bool:
        assigned = self._consumer.assignment()
        for tp, end in until.items():
            if end == 0:
                continue
            if tp not in assigned or await self._consumer.position(tp) < end:
                return False
        return True

    async def _commit_positions(self) -> None:
        positions = {tp: await self._consumer.position(tp) for tp in self._consumer.assignment()}
        if positions:
            await self._commit(positions)

    def _count(self, topic: str, event_type: str, result: str) -> None:
        events_counter.add(1, {"topic": topic, "type": event_type, "result": result, "consumer": self.role})


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


def _peek_type(record: Record) -> str:
    """O `type` do envelope, só para métricas e logs de mensagem que não será aplicada."""
    try:
        value = json.loads(record.value or b"")
    except ValueError:
        return "unknown"
    event_type = value.get("type") if isinstance(value, dict) else None
    return event_type if isinstance(event_type, str) else "unknown"

"""Envio para `<tópico>.dlt` das mensagens que não puderam ser aplicadas."""

import asyncio
import logging
from datetime import UTC, datetime

from aiokafka import AIOKafkaProducer
from aiokafka.structs import ConsumerRecord

logger = logging.getLogger(__name__)

_MAX_ERROR_LENGTH = 1000


def dlt_topic(topic: str) -> str:
    return f"{topic}.dlt"


class DeadLetterPublisher:
    """Publica a mensagem original, com a mesma chave e os mesmos cabeçalhos.

    Cabeçalhos acrescentados (`dlt.*`) dizem de onde ela veio e por que falhou,
    para a inspeção manual e o reprocessamento.
    """

    def __init__(self, bootstrap_servers: str) -> None:
        self._bootstrap_servers = bootstrap_servers
        self._producer: AIOKafkaProducer | None = None
        self._lock = asyncio.Lock()

    async def _started(self) -> AIOKafkaProducer:
        # Conecta na primeira mensagem: a subida do serviço não depende do Kafka.
        async with self._lock:
            if self._producer is None:
                producer = AIOKafkaProducer(
                    bootstrap_servers=self._bootstrap_servers,
                    client_id="notification-service-dlt",
                    acks="all",
                    enable_idempotence=True,
                )
                try:
                    await producer.start()
                except BaseException:
                    await producer.stop()
                    raise
                self._producer = producer
            return self._producer

    async def stop(self) -> None:
        async with self._lock:
            if self._producer is not None:
                await self._producer.stop()
                self._producer = None

    async def publish(self, record: ConsumerRecord[bytes, bytes], *, group_id: str, error: BaseException) -> None:
        message = f"{type(error).__name__}: {error}"[:_MAX_ERROR_LENGTH]
        headers = [
            *[(key, value) for key, value in record.headers if not key.startswith("dlt.")],
            ("dlt.original.topic", record.topic.encode()),
            ("dlt.original.partition", str(record.partition).encode()),
            ("dlt.original.offset", str(record.offset).encode()),
            ("dlt.consumer.group", group_id.encode()),
            ("dlt.error.class", type(error).__name__.encode()),
            ("dlt.error.message", message.encode()),
            ("dlt.failed.at", datetime.now(UTC).isoformat().encode()),
        ]
        producer = await self._started()
        await producer.send_and_wait(dlt_topic(record.topic), value=record.value, key=record.key, headers=headers)
        logger.error(
            "Mensagem enviada para a DLT",
            extra={
                "topic": record.topic,
                "partition": record.partition,
                "offset": record.offset,
                "consumerGroup": group_id,
                "error": message,
            },
        )

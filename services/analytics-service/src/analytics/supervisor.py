"""Supervisor do consumidor ao vivo.

Confere a cada `GENERATION_POLL_SECONDS` qual geração está ativa e mantém um
consumidor nela. Quando um replay troca o ponteiro (nesta instância, em outra ou
pela linha de comando), o supervisor para o consumidor da geração antiga e
começa o da nova, que continua do offset onde o replay parou. Também aponta as
views sem sufixo para a geração ativa e apaga as gerações aposentadas depois da
carência.
"""

import asyncio
import logging
from contextlib import suppress
from typing import Any

from aiokafka.errors import NonEmptyGroup
from pymongo.asynchronous.mongo_client import AsyncMongoClient

from analytics.config import Settings
from analytics.kafka.admin import delete_consumer_group
from analytics.kafka.consumer import GenerationConsumer
from analytics.kafka.dead_letter import DeadLetterPublisher
from analytics.store import read_models
from analytics.store.generations import GenerationRegistry

logger = logging.getLogger(__name__)

Doc = dict[str, Any]


class LiveSupervisor:
    def __init__(
        self,
        *,
        settings: Settings,
        client: AsyncMongoClient[Doc],
        registry: GenerationRegistry,
        dead_letter: DeadLetterPublisher,
    ) -> None:
        self._settings = settings
        self._client = client
        self._registry = registry
        self._dead_letter = dead_letter
        self._stopping = asyncio.Event()
        self._task: asyncio.Task[None] | None = None
        self._consumer: GenerationConsumer | None = None
        self._consumer_task: asyncio.Task[bool] | None = None
        self._views_generation: int | None = None

    @property
    def generation(self) -> int | None:
        """Geração que o consumidor ao vivo está alimentando."""
        return self._consumer.generation if self._consumer else None

    @property
    def consuming(self) -> bool:
        return self._consumer_task is not None and not self._consumer_task.done()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._loop(), name="analytics-live-supervisor")

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            await self._task
        await self._stop_consumer()

    async def reconcile(self) -> None:
        """Uma volta do supervisor. Exposta para os testes não dependerem do intervalo."""
        active = await self._registry.ensure_active()
        if self._consumer is None or self._consumer.generation != active or not self.consuming:
            await self._stop_consumer()
            await self._start_consumer(active)
        if self._views_generation != active:
            await read_models.point_views(self._registry.db, active)
            self._views_generation = active
        await self._drop_retired(active)

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                await self.reconcile()
            except Exception:
                logger.exception("Falha no supervisor do consumidor; tentando de novo")
            with suppress(TimeoutError):
                await asyncio.wait_for(self._stopping.wait(), timeout=self._settings.generation_poll_seconds)

    async def _start_consumer(self, generation: int) -> None:
        consumer = GenerationConsumer(
            settings=self._settings,
            client=self._client,
            db=self._registry.db,
            generation=generation,
            group_id=self._registry.group_id(generation),
            dead_letter=self._dead_letter,
            role="live",
        )
        try:
            await consumer.start()
        except BaseException:
            await consumer.close()
            raise
        self._consumer = consumer
        self._consumer_task = asyncio.create_task(consumer.run(), name=f"analytics-live-gen-{generation}")
        logger.info(
            "Consumidor ao vivo na geração",
            extra={"generation": generation, "consumerGroup": consumer.group_id},
        )

    async def _stop_consumer(self) -> None:
        consumer, task = self._consumer, self._consumer_task
        self._consumer, self._consumer_task = None, None
        if consumer is None:
            return
        consumer.request_stop()
        if task is not None:
            try:
                await task
            except Exception:
                logger.exception("O consumidor ao vivo parou com erro", extra={"generation": consumer.generation})
        await consumer.close()

    async def _drop_retired(self, active: int) -> None:
        for generation in await self._registry.droppable():
            if generation in (active, self.generation):
                continue
            await read_models.drop(self._registry.db, generation)
            try:
                await delete_consumer_group(self._settings.kafka_brokers, self._registry.group_id(generation))
            except NonEmptyGroup:
                # Um consumidor de outra instância ainda está no grupo; fica para a próxima volta.
                continue
            await self._registry.mark_dropped(generation)
            logger.info("Geração aposentada apagada", extra={"generation": generation})

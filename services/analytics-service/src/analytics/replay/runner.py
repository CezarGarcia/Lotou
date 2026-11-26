"""Replay: reconstrói todos os read models a partir do começo dos tópicos, sem parar a leitura.

1. Toma o lock do replay (um por vez) e reserva a geração N+1, com coleções
   novas e um consumer group novo.
2. Guarda o fim de cada partição neste instante (`end_offsets`).
3. Consome os três tópicos do começo para a geração N+1, até alcançar esses
   offsets. Enquanto isso, a API lê a geração N e o consumidor ao vivo segue
   alimentando a N.
4. Confirma as posições no consumer group da N+1 e troca o ponteiro numa
   transação. A API passa a ler a N+1 na requisição seguinte, e o supervisor
   move o consumidor ao vivo para o grupo da N+1, que continua de onde o replay
   parou.
5. A geração N fica aposentada e é apagada (coleções e consumer group) depois
   da carência.

Se algo falha, a geração N+1 é marcada como FAILED e apagada; a N continua ativa.
"""

import logging
import os
import socket
import time
import uuid
from dataclasses import dataclass
from typing import Any

from opentelemetry import trace
from pymongo.asynchronous.mongo_client import AsyncMongoClient

from analytics.config import Settings
from analytics.kafka.consumer import GenerationConsumer
from analytics.kafka.dead_letter import DeadLetterPublisher
from analytics.store.generations import GenerationRegistry

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("analytics-service")

Doc = dict[str, Any]


class ReplayStopped(Exception):
    """O replay foi interrompido (desligamento do processo) antes de alcançar o fim."""


@dataclass(frozen=True)
class ReplayResult:
    generation: int
    previous: int | None
    events_applied: int
    seconds: float


class ReplayRunner:
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
        self._owner = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        self._consumer: GenerationConsumer | None = None
        self._stop_requested = False

    async def prepare(self) -> int:
        """Toma o lock e reserva a geração. Levanta `ReplayInProgress` se outro replay está rodando."""
        await self._registry.acquire_replay_lock(self._owner)
        try:
            generation = await self._registry.allocate("replay")
            await self._registry.renew_replay_lock(self._owner, generation)
        except BaseException:
            await self._registry.release_replay_lock(self._owner)
            raise
        logger.info("Replay iniciado", extra={"generation": generation})
        return generation

    def request_stop(self) -> None:
        self._stop_requested = True
        if self._consumer is not None:
            self._consumer.request_stop()

    async def build(self, generation: int) -> ReplayResult:
        """Monta a geração reservada por `prepare` e troca o ponteiro. Libera o lock no fim."""
        started = time.monotonic()
        consumer = GenerationConsumer(
            settings=self._settings,
            client=self._client,
            db=self._registry.db,
            generation=generation,
            group_id=self._registry.group_id(generation),
            dead_letter=self._dead_letter,
            role="replay",
        )
        self._consumer = consumer
        renewed_at = time.monotonic()
        renew_every = self._settings.replay_lease_seconds / 3

        async def heartbeat() -> None:
            nonlocal renewed_at
            if time.monotonic() - renewed_at >= renew_every:
                await self._registry.renew_replay_lock(self._owner, generation)
                renewed_at = time.monotonic()

        try:
            with tracer.start_as_current_span(
                "analytics replay", attributes={"lotou.analytics.generation": generation}
            ):
                if self._stop_requested:
                    raise ReplayStopped("replay interrompido antes de começar")
                await consumer.start()
                end_offsets = await consumer.end_offsets()
                await self._registry.record_end_offsets(
                    generation,
                    [
                        {"topic": tp.topic, "partition": tp.partition, "offset": offset}
                        for tp, offset in end_offsets.items()
                    ],
                )
                if not await consumer.run(until=end_offsets, on_progress=heartbeat):
                    raise ReplayStopped("replay interrompido antes de alcançar o fim dos tópicos")
                # Sai do grupo antes da troca: o consumidor ao vivo entra nele logo depois.
                await consumer.close()
                previous = await self._registry.switch_to(
                    generation, lock_owner=self._owner, events_applied=consumer.events_applied
                )
        except BaseException as error:
            logger.exception("Replay falhou", extra={"generation": generation})
            await consumer.close()
            await self._registry.mark_failed(generation, f"{type(error).__name__}: {error}")
            await self._registry.release_replay_lock(self._owner)
            raise
        await self._registry.release_replay_lock(self._owner)

        result = ReplayResult(
            generation=generation,
            previous=previous,
            events_applied=consumer.events_applied,
            seconds=round(time.monotonic() - started, 3),
        )
        logger.info(
            "Replay concluído: geração ativa trocada",
            extra={
                "generation": generation,
                "previousGeneration": previous,
                "eventsApplied": result.events_applied,
                "seconds": result.seconds,
            },
        )
        return result

    async def run(self) -> ReplayResult:
        return await self.build(await self.prepare())

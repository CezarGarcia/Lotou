"""Consumidor de uma fila do RabbitMQ, com ack manual e parada graciosa.

Cada consumidor tem o seu canal, com o prefetch da fila: no máximo `prefetch`
mensagens entregues e ainda não confirmadas por consumidor. O aio-pika chama o
tratamento de cada mensagem numa tarefa própria, então até `prefetch` mensagens
são tratadas ao mesmo tempo.

Parada graciosa: cancela os consumidores (o broker para de entregar), espera as
mensagens em andamento terminarem e só então fecha os canais. Uma mensagem
entregue e não confirmada quando o canal fecha volta para a fila; nada se perde.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable

from aio_pika.abc import AbstractChannel, AbstractIncomingMessage, AbstractQueue, AbstractRobustConnection, ConsumerTag

from notification.rabbit import topology

logger = logging.getLogger(__name__)

Handler = Callable[[AbstractIncomingMessage], Awaitable[None]]


class QueueWorker:
    def __init__(
        self,
        *,
        connection: AbstractRobustConnection,
        queue: str,
        handler: Handler,
        prefetch: int,
        consumers: int = 1,
        retry_delays_seconds: tuple[float, ...],
    ) -> None:
        self.queue = queue
        self._connection = connection
        self._handler = handler
        self._prefetch = prefetch
        self._consumers = consumers
        self._retry_delays = retry_delays_seconds
        self._channels: list[tuple[AbstractChannel, AbstractQueue, ConsumerTag]] = []
        self._inflight: set[asyncio.Task[None]] = set()
        self._idle = asyncio.Event()
        self._idle.set()

    async def start(self) -> None:
        for _ in range(self._consumers):
            channel = await self._connection.channel()
            await channel.set_qos(prefetch_count=self._prefetch)
            queues = await topology.declare(channel, self._retry_delays)
            queue = queues[self.queue]
            tag = await queue.consume(self._on_message)
            self._channels.append((channel, queue, tag))

    async def stop(self, *, grace_seconds: float = 20.0) -> None:
        channels, self._channels = self._channels, []
        for channel, queue, tag in channels:
            if not channel.is_closed:
                try:
                    await queue.cancel(tag)
                except Exception:
                    logger.warning("Não foi possível cancelar o consumidor", extra={"queue": self.queue}, exc_info=True)
        try:
            await asyncio.wait_for(self._idle.wait(), timeout=grace_seconds)
        except TimeoutError:
            logger.warning(
                "Mensagens ainda em andamento na parada; voltam para a fila",
                extra={"queue": self.queue, "inflight": len(self._inflight)},
            )
        for channel, _, _ in channels:
            if not channel.is_closed:
                await channel.close()

    async def _on_message(self, message: AbstractIncomingMessage) -> None:
        task = asyncio.current_task()
        assert task is not None
        self._inflight.add(task)
        self._idle.clear()
        try:
            await self._handler(message)
        except Exception:
            # O tratamento confirma ou rejeita cada mensagem; chegar aqui é bug.
            # Rejeitar sem devolver à fila manda a mensagem para a DLQ (DLX da
            # fila), em vez de entrar num laço de reentrega.
            logger.exception("Erro inesperado ao tratar a mensagem", extra={"queue": self.queue})
            if not message.processed:
                try:
                    await message.reject(requeue=False)
                except Exception:
                    logger.warning("Não foi possível rejeitar a mensagem", extra={"queue": self.queue}, exc_info=True)
        finally:
            self._inflight.discard(task)
            if not self._inflight:
                self._idle.set()

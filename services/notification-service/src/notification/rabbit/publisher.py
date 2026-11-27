"""Publicação com confirmação do broker (publisher confirms).

`publish` só volta depois que o RabbitMQ confirmou que a mensagem está na fila
(gravada em disco, por ser persistente). Mensagem sem fila de destino volta
como erro (`mandatory`), em vez de sumir em silêncio. Quem chama só confirma
o que consumiu (offset do Kafka, ack da mensagem de origem) depois disso.

O `traceparent` entra nos cabeçalhos pela instrumentação do aio-pika, com o
span corrente; numa retentativa, o cabeçalho antigo é substituído pelo do
span da tentativa que falhou, então o trace mostra as tentativas em sequência.
"""

import asyncio
from collections.abc import Mapping
from datetime import UTC, datetime
from typing import Any

from aio_pika import DeliveryMode, Message
from aio_pika.abc import AbstractChannel, AbstractExchange, AbstractRobustConnection, HeadersType

from notification.rabbit import topology

# Cabeçalhos que o broker põe ou usa para rotear, e que não devem ser copiados
# numa republicação (a nova rota é decidida de novo a cada publicação).
_ROUTING_HEADERS = frozenset({"x-death", "CC", "BCC"})
_ROUTING_PREFIXES = ("x-first-death-", "x-last-death-")


class Publisher:
    def __init__(self, connection: AbstractRobustConnection, *, timeout: float = 10.0) -> None:
        self._connection = connection
        self._timeout = timeout
        self._channel: AbstractChannel | None = None
        self._exchanges: dict[str, AbstractExchange] = {}
        self._lock = asyncio.Lock()

    async def _exchange(self, name: str) -> AbstractExchange:
        async with self._lock:
            if self._channel is None or self._channel.is_closed:
                self._channel = await self._connection.channel(publisher_confirms=True)
                self._exchanges.clear()
            if name not in self._exchanges:
                self._exchanges[name] = await topology.exchange(self._channel, name)
            return self._exchanges[name]

    async def publish(
        self,
        exchange: str,
        routing_key: str,
        body: bytes,
        *,
        message_id: str,
        message_type: str,
        headers: Mapping[str, Any] | None = None,
        priority: int | None = None,
        also_route_to: str | None = None,
    ) -> None:
        """Publica e espera a confirmação. `also_route_to` vai no cabeçalho `CC`."""
        message_headers: HeadersType = dict(headers or {})
        if also_route_to is not None:
            message_headers["CC"] = [also_route_to]
        message = Message(
            body,
            content_type="application/json",
            content_encoding="utf-8",
            delivery_mode=DeliveryMode.PERSISTENT,
            message_id=message_id,
            type=message_type,
            priority=priority,
            timestamp=datetime.now(UTC),
            app_id="notification-service",
            headers=message_headers,
        )
        target = await self._exchange(exchange)
        await target.publish(message, routing_key, mandatory=True, timeout=self._timeout)

    async def close(self) -> None:
        async with self._lock:
            if self._channel is not None and not self._channel.is_closed:
                await self._channel.close()
            self._channel = None


def carried_headers(headers: Mapping[str, Any] | None) -> dict[str, Any]:
    """Os cabeçalhos da aplicação, sem os que o broker acrescentou ao rotear."""
    return {
        key: value
        for key, value in (headers or {}).items()
        if key not in _ROUTING_HEADERS and not key.startswith(_ROUTING_PREFIXES)
    }

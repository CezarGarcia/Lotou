"""Caos: serviço fora do ar e worker parado não perdem nada; a topologia é a do documento."""

import asyncio
from typing import Any
from urllib.parse import quote

import aio_pika
import httpx
from aiokafka import AIOKafkaProducer

from notification.api.app import create_app
from notification.rabbit import topology
from tests.events import order_cancelled, tickets_issued
from tests.fakes import FakeBackends
from tests.integration.conftest import RETRY_DELAYS, Infra, MailpitApi, publish, queue_depth, wait_for
from tests.tokens import FakeKeycloak


async def test_service_down_loses_nothing(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    mailpit: MailpitApi,
) -> None:
    """O experimento "notification-service fora do ar": os eventos esperam no Kafka."""
    show_id = backends.add_show(title="Noite do Caos")
    buyer_id = backends.add_buyer()

    async with run_service():
        pass  # sobe, entra no consumer group e cai (docker stop)

    for _ in range(3):
        await publish(producer, tickets_issued(buyer_id=buyer_id, show_id=show_id, seats=[None]))
    await publish(producer, order_cancelled(buyer_id=buyer_id, show_id=show_id))
    await asyncio.sleep(1)
    assert await mailpit.messages() == []

    async with run_service():
        found = await mailpit.wait_for(4)
        await asyncio.sleep(1)
        found = await mailpit.messages()

    assert sorted(message["Subject"] for message in found) == [
        "Pedido cancelado: Noite do Caos",
        *["Seus ingressos para Noite do Caos"] * 3,
    ]


async def test_email_worker_down_messages_wait_durably_in_the_queue(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
) -> None:
    show_id = backends.add_show(title="Fila Cheia")
    buyer_id = backends.add_buyer()

    # Só o Kafka e o PDF: o worker de e-mail está parado.
    async with run_service(components=frozenset({"kafka", "render"})):
        for _ in range(5):
            await publish(producer, tickets_issued(buyer_id=buyer_id, show_id=show_id, seats=["G-1", "G-2"]))
        await wait_for(lambda: _depth_is(rabbit, topology.EMAIL_QUEUE, 5))

    # Com o serviço inteiro parado, as mensagens continuam na fila, persistentes.
    assert await queue_depth(rabbit, topology.EMAIL_QUEUE) == 5
    channel = await rabbit.channel()
    queue = await channel.declare_queue(topology.EMAIL_QUEUE, passive=True, robust=False)
    waiting = await queue.get(no_ack=False)
    assert waiting.delivery_mode == aio_pika.DeliveryMode.PERSISTENT
    assert waiting.priority == 9
    await waiting.nack(requeue=True)
    await channel.close()
    assert await mailpit.messages() == []

    async with run_service(components=frozenset({"email"})):
        found = await mailpit.wait_for(5)

    assert len(found) == 5
    assert await queue_depth(rabbit, topology.EMAIL_QUEUE) == 0


async def _depth_is(connection: aio_pika.abc.AbstractRobustConnection, queue: str, expected: int) -> bool:
    return await queue_depth(connection, queue) == expected


async def test_topology_is_idempotent_and_matches_the_document(
    rabbit: aio_pika.abc.AbstractRobustConnection, infra: Infra
) -> None:
    for _ in range(2):  # declarar de novo não muda nada nem falha
        channel = await rabbit.channel()
        await topology.declare(channel, RETRY_DELAYS)
        await channel.close()

    async with httpx.AsyncClient(base_url=infra.rabbitmq.management_url, auth=("guest", "guest")) as api:

        async def get(kind: str, name: str) -> dict[str, Any]:
            response = await api.get(f"/api/{kind}/%2F/{quote(name, safe='')}")
            response.raise_for_status()
            body: dict[str, Any] = response.json()
            return body

        exchanges = {
            "tickets": "direct",
            "tickets.dlx": "fanout",
            "notifications": "topic",
            "notifications.retry": "direct",
            "notifications.dlx": "fanout",
        }
        for name, kind in exchanges.items():
            exchange = await get("exchanges", name)
            assert (exchange["type"], exchange["durable"]) == (kind, True), name

        email = await get("queues", "notifications.email")
        assert email["durable"] is True
        # O RabbitMQ 4 acrescenta `x-queue-type: classic`: compara só o que o serviço declara.
        assert {"x-max-priority": 10, "x-dead-letter-exchange": "notifications.dlx"}.items() <= email[
            "arguments"
        ].items()
        render = await get("queues", "tickets.render")
        assert render["arguments"]["x-dead-letter-exchange"] == "tickets.dlx"
        for key, seconds in zip(("10s", "1m", "5m"), RETRY_DELAYS, strict=True):
            retry = await get("queues", f"notifications.retry.{key}")
            assert retry["arguments"]["x-message-ttl"] == round(seconds * 1000)
            assert retry["arguments"]["x-dead-letter-exchange"] == "notifications"
            # Sem routing key fixa: volta a `notifications` com a do template (cabeçalho CC).
            assert "x-dead-letter-routing-key" not in retry["arguments"]

        bindings = (await api.get("/api/bindings/%2F")).json()
        routes = {(b["source"], b["routing_key"], b["destination"]) for b in bindings if b["source"]}
        assert {
            ("tickets", "render", "tickets.render"),
            ("tickets.dlx", "", "tickets.render.dlq"),
            ("notifications", "email.#", "notifications.email"),
            ("notifications.retry", "10s", "notifications.retry.10s"),
            ("notifications.retry", "1m", "notifications.retry.1m"),
            ("notifications.retry", "5m", "notifications.retry.5m"),
            ("notifications.dlx", "", "notifications.email.dlq"),
        } <= routes


async def test_health(make_settings: Any, backends: FakeBackends) -> None:
    app = create_app(make_settings(), jwks_http=FakeKeycloak().http_client(), http=backends.client())
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://notification") as client,
    ):
        assert (await client.get("/health/live")).json() == {"status": "ok"}

        async def ready() -> bool:
            return (await client.get("/health/ready")).status_code == 200

        await wait_for(ready)
        body = (await client.get("/health/ready")).json()
        assert body == {"status": "ok", "checks": {"rabbitmq": "up", "kafkaConsumer": "up", "redis": "up"}}

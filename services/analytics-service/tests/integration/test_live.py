"""Painel ao vivo de ponta a ponta: Kafka, MongoDB e Redis reais, duas instâncias do analytics
servidas pelo uvicorn e clientes WebSocket de verdade.

Este é o teste do critério da fase 4: "evento chega ao painel em menos de 2 s".
"""

import asyncio
import json
import time
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer, TopicPartition
from aiokafka.admin import AIOKafkaAdminClient
from fastapi import FastAPI
from redis.asyncio import Redis

from analytics.api.app import create_app
from analytics.config import Settings
from analytics.contracts import TOPICS
from analytics.kafka import admin as kafka_admin
from analytics.live import keys
from analytics.replay.__main__ import run as run_replay_cli
from analytics.store.generations import GenerationRegistry
from analytics.supervisor import LiveSupervisor
from tests import events
from tests.events import LotSpec, Message, OrderSpec, SectorSpec, ShowSpec
from tests.integration.containers import KafkaKraft, MongoReplicaSet, RedisCore
from tests.live_client import LiveClient, Server, serve
from tests.tokens import ISSUER, JWKS_URI, FakeKeycloak

pytestmark = pytest.mark.integration

PHASE_CRITERION_SECONDS = 2.0
TIMEOUT = 60.0


@dataclass
class Instance:
    app: FastAPI
    server: Server

    @property
    def url(self) -> str:
        return self.server.url("/v1/analytics/live")

    @property
    def registry(self) -> GenerationRegistry:
        registry: GenerationRegistry = self.app.state.registry
        return registry

    @property
    def supervisor(self) -> LiveSupervisor:
        supervisor: LiveSupervisor = self.app.state.supervisor
        return supervisor


@dataclass
class Cluster:
    settings: Settings
    keycloak: FakeKeycloak
    instances: list[Instance]
    producer: AIOKafkaProducer
    redis: Redis

    @property
    def registry(self) -> GenerationRegistry:
        return self.instances[0].registry

    def token(self, producer_id: str, roles: list[str] | None = None, **kwargs: Any) -> str:
        return self.keycloak.token(producer_id, roles or ["producer"], **kwargs)

    async def client(self, instance: int, producer_id: str) -> LiveClient:
        client = await LiveClient.open(self.instances[instance].url)
        await client.auth(self.token(producer_id))
        return client

    async def publish(self, *messages: Message) -> None:
        for message in messages:
            await self.producer.send_and_wait(
                message.topic, message.raw(), key=message.key.encode(), headers=message.headers
            )

    async def feed(self, show_id: str) -> list[dict[str, Any]]:
        """O stream de atividade do show, do mais antigo ao mais novo."""
        return [
            {"id": stream_id, **json.loads(fields["entry"])}
            for stream_id, fields in await self.redis.xrange(keys.activity_stream(show_id))
        ]

    async def caught_up(self) -> None:
        """Espera as duas instâncias estarem na geração ativa com tudo o que foi publicado confirmado."""
        ends = await _end_offsets(self.settings.kafka_brokers)
        admin = AIOKafkaAdminClient(bootstrap_servers=self.settings.kafka_brokers)
        await admin.start()
        try:

            async def done() -> bool:
                generation = await self.registry.active_generation()
                if generation is None or any(i.supervisor.generation != generation for i in self.instances):
                    return False
                committed = await admin.list_consumer_group_offsets(self.registry.group_id(generation))
                return all(end == 0 or (tp in committed and committed[tp].offset >= end) for tp, end in ends.items())

            await eventually(done, "os consumidores ao vivo não alcançaram o fim dos tópicos")
        finally:
            await admin.close()


async def eventually(check: Any, message: str, within: float = TIMEOUT) -> None:
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        if await check():
            return
        await asyncio.sleep(0.1)
    raise AssertionError(message)


async def _end_offsets(bootstrap: str) -> dict[TopicPartition, int]:
    consumer = AIOKafkaConsumer(bootstrap_servers=bootstrap, isolation_level="read_committed")
    await consumer.start()
    try:
        return dict(await consumer.end_offsets(await kafka_admin.partitions(bootstrap, TOPICS)))
    finally:
        await consumer.stop()


async def _serve(app: FastAPI) -> Instance:
    server = await serve(app)
    return Instance(app=app, server=server)


@pytest.fixture(scope="module")
async def cluster(
    mongo: MongoReplicaSet, kafka: KafkaKraft, redis_core: RedisCore, topics: list[str]
) -> AsyncIterator[Cluster]:
    keycloak = FakeKeycloak()
    # As duas instâncias dividem o banco, o consumer group e o Redis, como no Compose escalado.
    settings = Settings(
        mongodb_uri=mongo.uri(f"analytics_live_{uuid.uuid4().hex[:8]}"),
        kafka_brokers=kafka.bootstrap_servers,
        kafka_group_id=f"analytics-live-{uuid.uuid4().hex[:6]}",
        redis_url=redis_core.url,
        auth_issuer=ISSUER,
        auth_jwks_uri=JWKS_URI,
        generation_poll_seconds=0.2,
        retired_generation_grace_seconds=1,
        consumer_max_attempts=2,
        otel_sdk_disabled=True,
    )
    instances = [await _serve(create_app(settings, jwks_http=keycloak.http_client())) for _ in range(2)]
    producer = AIOKafkaProducer(bootstrap_servers=kafka.bootstrap_servers, acks="all")
    await producer.start()
    redis = Redis.from_url(redis_core.url, decode_responses=True)
    try:
        cluster = Cluster(settings, keycloak, instances, producer, redis)
        await cluster.caught_up()
        yield cluster
    finally:
        await producer.stop()
        await redis.aclose()
        for instance in instances:
            await instance.server.stop()


# ---------------------------------------------------------------- cenário


@dataclass
class Show:
    spec: ShowSpec
    pista: SectorSpec
    lot1: LotSpec
    lot2: LotSpec

    @property
    def id(self) -> str:
        return self.spec.id

    @property
    def producer_id(self) -> str:
        return self.spec.producer_id

    def order(self, seats: int = 2, lot: LotSpec | None = None) -> OrderSpec:
        return events.order(self.spec, self.pista, lot or self.lot1, (None,) * seats, datetime.now(UTC))


def now() -> datetime:
    return datetime.now(UTC)


async def published_show(cluster: Cluster, *, producer_id: str | None = None) -> Show:
    """Um show à venda com o 1º lote aberto, já aplicado e no feed."""
    lot1 = LotSpec(id=events.uuid7(), name="1º lote", price_cents=12000, quantity=100)
    lot2 = LotSpec(id=events.uuid7(), name="2º lote", price_cents=15000, quantity=100)
    pista = SectorSpec(id=events.uuid7(), name="Pista", kind="GENERAL_ADMISSION", capacity=200, lots=(lot1, lot2))
    spec = ShowSpec(
        id=events.uuid7(),
        producer_id=producer_id or str(uuid.uuid4()),
        title="Noite de Estreia",
        artist="Banda do Bairro",
        starts_at=now() + timedelta(days=30),
        sectors=(pista,),
    )
    show = Show(spec, pista, lot1, lot2)
    await cluster.publish(events.show_event(spec, version=1, status="ON_SALE", at=now(), event_type="ShowPublished"))

    # Como na vida real: o inventory só abre o lote de um show que já está no catálogo.
    # (Tópicos diferentes não têm ordem entre si; antes do show, o feed sai sem os nomes.)
    async def in_catalog() -> bool:
        generation = await cluster.registry.active_generation()
        return await cluster.registry.db[f"shows_g{generation}"].find_one({"_id": spec.id}) is not None

    await eventually(in_catalog, "o show não chegou ao catálogo do analytics")
    await cluster.publish(events.lot_opened(spec, pista, lot1, now()))

    async def in_feed() -> bool:
        return len(await cluster.feed(show.id)) == 1

    await eventually(in_feed, "o LotOpened não chegou ao feed")
    return show


# ------------------------------------------------------------------ testes


async def test_activity_reaches_both_instances_in_under_two_seconds(cluster: Cluster) -> None:
    show = await published_show(cluster)
    one = await cluster.client(0, show.producer_id)
    two = await cluster.client(1, show.producer_id)
    try:
        snapshot = await one.subscribe(show.id)
        assert snapshot["type"] == "snapshot"
        assert snapshot["metrics"]["ticketsSold"] == 0
        (sector,) = snapshot["metrics"]["sectors"]
        assert (sector["name"], sector["capacity"], sector["sold"], sector["remaining"]) == ("Pista", 200, 0, 200)
        assert sector["currentLot"] == {
            "lotId": show.lot1.id,
            "name": "1º lote",
            "priceCents": 12000,
            "status": "ON_SALE",
        }
        (opened,) = snapshot["activity"]
        assert (opened["type"], opened["sectorName"], opened["lotName"], opened["priceCents"]) == (
            "LotOpened",
            "Pista",
            "1º lote",
            12000,
        )
        assert (await two.subscribe(show.id))["type"] == "snapshot"

        # Métricas a cada segundo, nas duas instâncias, mesmo com uma só calculando por segundo.
        for client in (one, two):
            await client.wait_for(lambda f: f["type"] == "metrics" and f["showId"] == show.id, within=5)

        order = show.order(seats=3)
        marks = (one.mark(), two.mark())
        confirmed = order.confirmed(now())
        published_at = time.monotonic()
        await cluster.publish(order.created(now()), confirmed)

        occurred_at = datetime.fromisoformat(confirmed.value["occurredAt"]).timestamp()
        for client, mark in zip((one, two), marks, strict=True):
            received = await client.wait_for(
                lambda f: f["type"] == "activity" and f["entry"]["type"] == "OrderConfirmed", since=mark
            )
            # O critério da fase 4, medido do publish no Kafka e do occurredAt do fato.
            assert received.monotonic - published_at < PHASE_CRITERION_SECONDS
            assert received.wall - occurred_at < PHASE_CRITERION_SECONDS
            entry = received.frame["entry"]
            assert received.frame["showId"] == show.id
            assert entry == {
                "id": entry["id"],
                "eventId": confirmed.event_id,
                "type": "OrderConfirmed",
                "at": entry["at"],
                "orderId": order.id,
                "sectorName": "Pista",
                "quantity": 3,
                "totalCents": 39600,  # 3 x 120,00 + a taxa de 10%, que este show repassa ao comprador
            }
            assert keys.parse_stream_id(entry["id"]) > keys.parse_stream_id(opened["id"])

            # A métrica seguinte já tem a venda.
            metrics = (
                await client.wait_for(
                    lambda f: f["type"] == "metrics" and f["metrics"]["ticketsSold"] == 3, since=mark, within=5
                )
            ).frame["metrics"]
            assert (metrics["revenueCents"], metrics["ordersConfirmed"], metrics["ordersLastMinute"]) == (36000, 1, 1)
            assert (metrics["sectors"][0]["sold"], metrics["sectors"][0]["remaining"]) == (3, 197)

        # Cada evento uma vez só no stream, e o OrderCreated não entra no feed.
        feed = await cluster.feed(show.id)
        assert [item["type"] for item in feed] == ["LotOpened", "OrderConfirmed"]

        # Quem assina depois recebe a atividade na foto, do mais novo para o mais antigo.
        late = await cluster.client(1, show.producer_id)
        try:
            snapshot = await late.subscribe(show.id)
            assert [item["type"] for item in snapshot["activity"]] == ["OrderConfirmed", "LotOpened"]
            assert snapshot["metrics"]["ticketsSold"] == 3
        finally:
            await late.close()
    finally:
        await one.close()
        await two.close()


async def test_nothing_is_lost_between_the_snapshot_and_live_frames(cluster: Cluster) -> None:
    """Eventos chegando enquanto o cliente assina: cada um aparece uma vez, na foto ou ao vivo."""
    show = await published_show(cluster)
    orders = [show.order(seats=1) for _ in range(12)]
    client = await cluster.client(0, show.producer_id)
    try:

        async def sell() -> None:
            for order in orders:
                await cluster.publish(order.confirmed(now()))
                await asyncio.sleep(0.03)

        selling = asyncio.create_task(sell())
        await asyncio.sleep(0.1)
        snapshot = await client.subscribe(show.id)
        await selling
        in_snapshot = [item["eventId"] for item in snapshot["activity"]]

        def live() -> list[str]:
            return [f["entry"]["eventId"] for f in client.frames if f["type"] == "activity"]

        await client.wait_for(lambda _: len(in_snapshot) + len(live()) >= 1 + len(orders))
        await asyncio.sleep(0.5)  # nada além disso pode chegar
        assert len(live()) == len(set(live()))
        assert not set(live()) & set(in_snapshot)
        assert len(in_snapshot) + len(live()) == 1 + len(orders)
    finally:
        await client.close()


async def test_check_in_and_refund_reach_the_dashboard_in_under_two_seconds(cluster: Cluster) -> None:
    show = await published_show(cluster)
    sold, refunded = show.order(seats=2), show.order(seats=1)
    await cluster.publish(
        sold.confirmed(now()), sold.tickets_issued(now()), refunded.confirmed(now()), refunded.tickets_issued(now())
    )
    client = await cluster.client(0, show.producer_id)
    try:
        await client.subscribe(show.id)
        await client.wait_for(lambda f: f["type"] == "metrics" and f["metrics"]["ticketsSold"] == 3, within=10)

        # Entrada na portaria: outro tópico (checkin.events), chave do show.
        mark = client.mark()
        gate = sold.checked_in(0, "Portão Norte", now())
        published_at = time.monotonic()
        await cluster.publish(gate)
        received = await client.wait_for(
            lambda f: f["type"] == "activity" and f["entry"]["type"] == "TicketCheckedIn", since=mark
        )
        assert received.monotonic - published_at < PHASE_CRITERION_SECONDS
        entry = received.frame["entry"]
        assert entry == {
            "id": entry["id"],
            "eventId": gate.event_id,
            "type": "TicketCheckedIn",
            "at": entry["at"],
            "sectorName": "Pista",
            "gate": "Portão Norte",
        }
        metrics = (
            await client.wait_for(lambda f: f["type"] == "metrics" and f["metrics"]["checkedIn"] == 1, since=mark)
        ).frame["metrics"]
        assert metrics["checkinsByGate"] == [{"gate": "Portão Norte", "count": 1}]

        # Cancelamento e estorno: o pedido sai das vendas e entra nos reembolsados.
        mark = client.mark()
        refund = refunded.refunded(now())
        published_at = time.monotonic()
        await cluster.publish(refunded.tickets_cancelled(now()), refund)
        received = await client.wait_for(
            lambda f: f["type"] == "activity" and f["entry"]["type"] == "OrderRefunded", since=mark
        )
        assert received.monotonic - published_at < PHASE_CRITERION_SECONDS
        entry = received.frame["entry"]
        assert entry == {
            "id": entry["id"],
            "eventId": refund.event_id,
            "type": "OrderRefunded",
            "at": entry["at"],
            "orderId": refunded.id,
            "refundedCents": 13200,
            "reason": "ORDER_CANCELLED",
        }
        metrics = (
            await client.wait_for(lambda f: f["type"] == "metrics" and f["metrics"]["ordersRefunded"] == 1, since=mark)
        ).frame["metrics"]
        assert (metrics["ticketsSold"], metrics["revenueCents"], metrics["ordersConfirmed"]) == (2, 24000, 2)
        assert (metrics["sectors"][0]["sold"], metrics["sectors"][0]["remaining"]) == (2, 198)
        assert metrics["checkedIn"] == 1

        # O feed não identifica o comprador nem o ingresso.
        feed = await cluster.feed(show.id)
        assert [item["type"] for item in feed][-2:] == ["TicketCheckedIn", "OrderRefunded"]
        serialized = json.dumps(feed)
        assert sold.buyer_id not in serialized
        assert sold.ticket_ids[0] not in serialized
    finally:
        await client.close()


async def test_only_the_producer_of_the_show_can_subscribe(cluster: Cluster) -> None:
    mine = await published_show(cluster)
    theirs = await published_show(cluster)
    client = await cluster.client(0, mine.producer_id)
    try:
        for show_id in (theirs.id, str(uuid.uuid4())):
            error = await client.subscribe(show_id)
            assert error == {
                "type": "error",
                "code": "forbidden",
                "detail": "Show não encontrado ou de outro produtor.",
                "showId": show_id,
            }
        mark = client.mark()
        await client.send(type="subscribe", showId="nao-e-uuid")
        bad = (await client.wait_for(lambda f: f["type"] == "error", since=mark)).frame
        assert bad["code"] == "bad-request"
        # A conexão segue aberta e o próprio show funciona.
        assert (await client.subscribe(mine.id))["type"] == "snapshot"
        await cluster.publish(theirs.order().confirmed(now()))
        await asyncio.sleep(1.5)
        assert all(f.get("showId") != theirs.id for f in client.frames if f["type"] in ("metrics", "activity"))
    finally:
        await client.close()


async def test_unsubscribe_stops_the_frames(cluster: Cluster) -> None:
    show = await published_show(cluster)
    client = await cluster.client(1, show.producer_id)
    try:
        await client.subscribe(show.id)
        await client.wait_for(lambda f: f["type"] == "metrics", within=5)
        await client.send(type="unsubscribe", showId=show.id)
        await asyncio.sleep(0.5)  # frames que já estavam no fio
        mark = client.mark()
        await cluster.publish(show.order().confirmed(now()))
        await asyncio.sleep(2.5)
        assert [f for f in client.frames[mark:] if f.get("showId") == show.id] == []
        assert not client.closed.is_set()
    finally:
        await client.close()


async def test_a_buyer_token_is_refused_and_an_expired_token_closes_the_connection(cluster: Cluster) -> None:
    buyer = await LiveClient.open(cluster.instances[0].url)
    await buyer.send(type="auth", token=cluster.token("comprador", ["buyer"]))
    assert await buyer.wait_closed() == 4403

    show = await published_show(cluster)
    client = await LiveClient.open(cluster.instances[1].url)
    await client.auth(cluster.token(show.producer_id, expires_in=2))
    await client.subscribe(show.id)
    assert await client.wait_closed(within=5) == 4401


async def test_replay_does_not_duplicate_the_feed(cluster: Cluster, monkeypatch: pytest.MonkeyPatch) -> None:
    """Na troca de geração, o consumidor ao vivo da geração nova continua de onde o replay
    parou e reaplica o que a geração antiga aplicou nesse meio-tempo; o feed não pode repetir.

    O teste abre essa janela de propósito: depois que o replay terminou de ler e antes de
    trocar o ponteiro, publica pedidos e espera a geração antiga aplicá-los (e pô-los no feed).
    """
    show = await published_show(cluster)
    before = [show.order(seats=1) for _ in range(3)]
    await cluster.publish(*(order.confirmed(now()) for order in before))
    await cluster.caught_up()

    in_the_window = [show.order(seats=1) for _ in range(3)]
    cancelled = show.order(seats=2)
    original_switch = GenerationRegistry.switch_to

    async def switch_after_traffic(self: GenerationRegistry, generation: int, **kwargs: Any) -> int | None:
        await cluster.publish(*(order.confirmed(now()) for order in in_the_window))
        await cluster.publish(cancelled.created(now()), cancelled.cancelled(now(), "PAYMENT_DECLINED"))

        async def old_generation_fed_them() -> bool:
            return len(await cluster.feed(show.id)) == 1 + len(before) + len(in_the_window) + 1

        await eventually(old_generation_fed_them, "a geração antiga não aplicou os pedidos da janela")
        return await original_switch(self, generation, **kwargs)

    monkeypatch.setattr(GenerationRegistry, "switch_to", switch_after_traffic)
    old = await cluster.registry.active_generation()
    assert await run_replay_cli(cluster.settings) == 0
    monkeypatch.undo()
    await cluster.caught_up()
    new = await cluster.registry.active_generation()
    assert new != old

    # A geração nova reaplicou a janela (os read models têm os pedidos)...
    statement = await cluster.registry.db[f"producer_statements_g{new}"].find_one({"_id": show.id})
    assert statement["confirmedOrders"] == len(before) + len(in_the_window)
    # ...e o feed tem cada fato uma vez só.
    feed = await cluster.feed(show.id)
    event_ids = [item["eventId"] for item in feed]
    assert len(event_ids) == len(set(event_ids))
    types = [item["type"] for item in feed]
    assert types.count("OrderConfirmed") == len(before) + len(in_the_window)
    assert types.count("OrderCancelled") == 1
    assert len(feed) == 1 + len(before) + len(in_the_window) + 1

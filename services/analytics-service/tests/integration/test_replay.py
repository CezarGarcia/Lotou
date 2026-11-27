"""De ponta a ponta, com Kafka e MongoDB reais: eventos publicados viram read models,
e o replay reconstrói os mesmos read models sem parar a leitura.

Este é o teste do critério da fase 3 ("replay reconstrói os read models").
"""

import asyncio
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any

import httpx
import pytest
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer, TopicPartition
from aiokafka.admin import AIOKafkaAdminClient

from analytics.api.app import create_app
from analytics.config import Settings
from analytics.contracts import TOPICS
from analytics.kafka import admin as kafka_admin
from analytics.kafka.consumer import GenerationConsumer
from analytics.replay.__main__ import run as run_replay_cli
from analytics.store.generations import GenerationRegistry, GenerationStatus
from analytics.store.read_models import ALL_COLLECTIONS, collection_name
from analytics.supervisor import LiveSupervisor
from tests import events
from tests.events import Message, OrderSpec
from tests.integration.containers import KafkaKraft, MongoReplicaSet, RedisCore
from tests.readmodels import assert_same, snapshot
from tests.scenario import Raw, Scenario, at, build
from tests.tokens import ISSUER, JWKS_URI, FakeKeycloak

pytestmark = pytest.mark.integration

TIMEOUT = 90.0


@dataclass
class Service:
    settings: Settings
    http: httpx.AsyncClient
    keycloak: FakeKeycloak
    registry: GenerationRegistry
    supervisor: LiveSupervisor
    producer: AIOKafkaProducer

    @property
    def db(self) -> Any:
        return self.registry.db

    def as_producer(self, scenario_show: Any) -> dict[str, str]:
        return self.keycloak.bearer(scenario_show.producer_id, ["producer"])

    def as_service(self) -> dict[str, str]:
        return self.keycloak.bearer("service-account-ops", ["service"])

    async def publish(self, messages: list[Message | Raw], *, pause: float = 0.0) -> None:
        for message in messages:
            if isinstance(message, Message):
                await self.producer.send_and_wait(
                    message.topic, message.raw(), key=message.key.encode(), headers=message.headers
                )
            else:
                await self.producer.send_and_wait(message.topic, message.value, key=message.key.encode())
            if pause:
                await asyncio.sleep(pause)

    async def caught_up(self) -> None:
        """Espera o consumidor da geração ativa confirmar tudo o que já foi publicado."""
        ends = await _end_offsets(self.settings.kafka_brokers)
        admin = AIOKafkaAdminClient(bootstrap_servers=self.settings.kafka_brokers)
        await admin.start()
        try:

            async def done() -> bool:
                generation = await self.registry.active_generation()
                if generation is None or self.supervisor.generation != generation:
                    return False
                committed = await admin.list_consumer_group_offsets(self.registry.group_id(generation))
                return all(end == 0 or (tp in committed and committed[tp].offset >= end) for tp, end in ends.items())

            await eventually(done, "o consumidor ao vivo não alcançou o fim dos tópicos")
        finally:
            await admin.close()


async def eventually(check: Callable[[], Awaitable[bool]], message: str) -> None:
    deadline = time.monotonic() + TIMEOUT
    while time.monotonic() < deadline:
        if await check():
            return
        await asyncio.sleep(0.2)
    raise AssertionError(message)


async def _end_offsets(bootstrap: str) -> dict[TopicPartition, int]:
    consumer = AIOKafkaConsumer(bootstrap_servers=bootstrap, isolation_level="read_committed")
    await consumer.start()
    try:
        return dict(await consumer.end_offsets(await kafka_admin.partitions(bootstrap, TOPICS)))
    finally:
        await consumer.stop()


@pytest.fixture(scope="module")
async def service(
    mongo: MongoReplicaSet, kafka: KafkaKraft, redis_core: RedisCore, topics: list[str]
) -> AsyncIterator[Service]:
    keycloak = FakeKeycloak()
    settings = Settings(
        mongodb_uri=mongo.uri(f"analytics_e2e_{uuid.uuid4().hex[:8]}"),
        kafka_brokers=kafka.bootstrap_servers,
        kafka_group_id=f"analytics-test-{uuid.uuid4().hex[:6]}",
        redis_url=redis_core.url,
        auth_issuer=ISSUER,
        auth_jwks_uri=JWKS_URI,
        generation_poll_seconds=0.2,
        retired_generation_grace_seconds=1,
        consumer_max_attempts=2,
        otel_sdk_disabled=True,
    )
    app = create_app(settings, jwks_http=keycloak.http_client())
    producer = AIOKafkaProducer(bootstrap_servers=kafka.bootstrap_servers, acks="all")
    await producer.start()
    try:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://analytics") as http,
        ):
            yield Service(
                settings=settings,
                http=http,
                keycloak=keycloak,
                registry=app.state.registry,
                supervisor=app.state.supervisor,
                producer=producer,
            )
    finally:
        await producer.stop()


async def published(service: Service) -> Scenario:
    scenario = build()
    await service.publish(scenario.all_in_publish_order())
    await service.caught_up()
    return scenario


# ---------------------------------------------------------------------------


async def test_read_models_follow_the_events(service: Service) -> None:
    scenario = await published(service)
    a, b = scenario.show_a, scenario.show_b
    as_a = service.as_producer(a)

    response = await service.http.get(f"/v1/analytics/shows/{a.id}/sales", headers=as_a)
    assert response.status_code == 200, response.text
    sales = response.json()
    assert sales["title"] == scenario.new_title
    assert sales["timezone"] == "America/Sao_Paulo"
    assert sales["totals"] == {
        "ticketsSold": 9,
        "capacity": 2080,
        "occupancy": 0.0043,
        "revenueCents": 128000,
        "orders": 3,
    }
    pista, plateia = sales["sectors"]
    assert (pista["name"], pista["ticketsSold"], pista["occupancy"], pista["revenueCents"]) == (
        "Pista",
        7,
        0.0035,
        96000,
    )
    assert (plateia["name"], plateia["ticketsSold"], plateia["occupancy"]) == ("Plateia", 2, 0.025)
    lot1, lot2 = pista["lots"]
    assert (lot1["ticketsSold"], lot1["status"], lot1["soldOutAt"]) == (3, "SOLD_OUT", "2026-11-26T19:20:00Z")
    assert (lot2["ticketsSold"], lot2["status"], lot2["openedAt"]) == (4, "ON_SALE", "2026-11-26T19:20:00Z")
    assert [(h["hour"], h["ticketsSold"], h["revenueCents"], h["orders"]) for h in sales["hourly"]] == [
        ("2026-11-26T18:00:00Z", 5, 68000, 2),
        ("2026-11-26T19:00:00Z", 4, 60000, 1),
    ]

    statement = (await service.http.get(f"/v1/analytics/shows/{a.id}/statement", headers=as_a)).json()
    assert statement | {"lastEventAt": None} == {
        "showId": a.id,
        "title": scenario.new_title,
        "status": "ON_SALE",
        "partial": True,
        "currency": "BRL",
        "grossSalesCents": 128000,
        "discountsCents": 0,
        "refundsCents": 0,
        "platformFeeCents": 0,
        "receivableCents": 128000,
        "ordersCreated": 5,
        "confirmedOrders": 3,
        "cancelledOrders": 2,
        "cancelledByReason": {"PAYMENT_DECLINED": 1, "RESERVATION_EXPIRED": 1},
        "ticketsSold": 9,
        "ticketsIssued": 5,
        "lastEventAt": None,
    }

    # Paginação por cursor, do pedido mais novo para o mais antigo.
    seen: list[dict[str, Any]] = []
    cursor = None
    while True:
        params = {"limit": "2"} | ({"cursor": cursor} if cursor else {})
        page = (await service.http.get(f"/v1/analytics/shows/{a.id}/orders", params=params, headers=as_a)).json()
        seen.extend(page["items"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    expected = [scenario.orders[name] for name in ("o5", "o4", "o3", "o2", "o1")]
    assert [order["orderId"] for order in seen] == [order.id for order in expected]
    assert [order["status"] for order in seen] == ["CONFIRMED", "CANCELLED", "CANCELLED", "CONFIRMED", "CONFIRMED"]
    assert all(order["show"]["title"] == scenario.new_title for order in seen)
    assert "buyerId" not in seen[0]

    cancelled = (
        await service.http.get(f"/v1/analytics/shows/{a.id}/orders", params={"status": "CANCELLED"}, headers=as_a)
    ).json()
    assert [order["cancelReason"] for order in cancelled["items"]] == ["RESERVATION_EXPIRED", "PAYMENT_DECLINED"]

    # O pedido do show B chegou antes do show, e o título foi preenchido depois.
    orders_b = (await service.http.get(f"/v1/analytics/shows/{b.id}/orders", headers=service.as_producer(b))).json()
    assert [order["show"]["title"] for order in orders_b["items"]] == ["Samba de Quinta"]


async def test_producer_lists_only_their_shows(service: Service) -> None:
    scenario = await published(service)
    a = scenario.show_a
    # Mais dois shows do mesmo produtor, para a lista ter mais de uma página.
    others = [replace(a, id=events.uuid7(), title=f"Show extra {n}") for n in (1, 2)]
    await service.publish(
        [
            events.show_event(show, version=1, status="PUBLISHED", at=at(16), event_type="ShowPublished")
            for show in others
        ]
    )
    await service.caught_up()

    seen: list[dict[str, Any]] = []
    cursor = None
    while True:
        params = {"limit": "2"} | ({"cursor": cursor} if cursor else {})
        response = await service.http.get("/v1/analytics/shows", params=params, headers=service.as_producer(a))
        assert response.status_code == 200, response.text
        page = response.json()
        seen.extend(page["items"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    # Do mais novo para o mais antigo (o showId é UUID v7); o show B é de outro produtor.
    assert [show["showId"] for show in seen] == sorted([a.id, *(show.id for show in others)], reverse=True)
    by_id = {show["showId"]: show for show in seen}
    assert by_id[a.id] == {
        "showId": a.id,
        "title": scenario.new_title,
        "artist": a.artist,
        "startsAt": a.starts_at.isoformat().replace("+00:00", "Z"),
        "timezone": "America/Sao_Paulo",
        "venueName": "Teatro Guanabara",
        "city": "Rio de Janeiro",
        "status": "ON_SALE",
        "ticketsSold": 9,
        "revenueCents": 128000,
    }
    assert (by_id[others[0].id]["ticketsSold"], by_id[others[0].id]["revenueCents"]) == (0, 0)

    buyer = await service.http.get("/v1/analytics/shows", headers=service.keycloak.bearer(a.producer_id, ["buyer"]))
    assert buyer.status_code == 403
    bad = await service.http.get("/v1/analytics/shows", params={"cursor": "lixo"}, headers=service.as_producer(a))
    assert bad.status_code == 400


async def test_api_errors_are_problem_details(service: Service) -> None:
    scenario = await published(service)
    a, b = scenario.show_a, scenario.show_b
    url = f"/v1/analytics/shows/{a.id}/sales"

    cases = [
        (await service.http.get(url), 401, "unauthorized"),
        (await service.http.get(url, headers=service.keycloak.bearer(a.producer_id, ["buyer"])), 403, "forbidden"),
        # Show de outro produtor: 404, sem revelar que o show existe.
        (await service.http.get(url, headers=service.as_producer(b)), 404, "not-found"),
        (
            await service.http.get(f"/v1/analytics/shows/{uuid.uuid4()}/statement", headers=service.as_producer(a)),
            404,
            "not-found",
        ),
        (await service.http.get("/v1/analytics/shows/nao-e-uuid/sales", headers=service.as_producer(a)), 400, None),
        (
            await service.http.get(
                f"/v1/analytics/shows/{a.id}/orders", params={"cursor": "lixo"}, headers=service.as_producer(a)
            ),
            400,
            None,
        ),
        (
            await service.http.post("/internal/v1/replay", headers=service.as_producer(a)),
            403,
            "forbidden",
        ),
    ]
    for response, status, slug in cases:
        assert response.status_code == status, response.text
        assert response.headers["content-type"] == "application/problem+json"
        body = response.json()
        assert body["type"] == f"urn:lotou:problem:{slug or 'validation-error'}"
        assert body["status"] == status


async def test_invalid_messages_go_to_the_dlt_and_the_consumer_moves_on(service: Service) -> None:
    scenario = await published(service)
    consumer = AIOKafkaConsumer(
        "order.events.dlt", bootstrap_servers=service.settings.kafka_brokers, auto_offset_reset="earliest"
    )
    await consumer.start()
    try:
        batches = await consumer.getmany(timeout_ms=5000)
        records = [record for batch in batches.values() for record in batch]
    finally:
        await consumer.stop()
    ours = [record for record in records if record.key == scenario.orders["o5"].id.encode()]
    assert len(ours) >= 2
    headers = dict(ours[0].headers)
    assert headers["dlt.original.topic"] == b"order.events"
    assert headers["dlt.error.class"] == b"ContractError"
    assert {record.value for record in ours} >= {invalid.value for invalid in scenario.invalid}

    # Depois das mensagens inválidas, o pedido seguinte foi aplicado normalmente.
    health = await service.http.get("/health/ready")
    assert health.status_code == 200
    assert health.json()["checks"] == {"mongodb": "up", "redis": "up", "kafkaConsumer": "up"}


async def test_replay_rebuilds_the_same_read_models_without_downtime(
    service: Service, monkeypatch: pytest.MonkeyPatch
) -> None:
    scenario = await published(service)
    # Um replay de poucas centenas de eventos termina em instantes. Cada lote do
    # replay fica mais lento aqui, para a API ser lida com certeza durante a montagem.
    original_process = GenerationConsumer._process

    async def slow_replay(self: GenerationConsumer, tp: TopicPartition, records: Any) -> None:
        if self.role == "replay":
            await asyncio.sleep(0.3)
        await original_process(self, tp, records)

    monkeypatch.setattr(GenerationConsumer, "_process", slow_replay)
    a = scenario.show_a
    sales_url = f"/v1/analytics/shows/{a.id}/sales"
    old = await service.registry.active_generation()
    assert old is not None
    before = await snapshot(service.db, old)
    sales_before = (await service.http.get(sales_url, headers=service.as_producer(a))).json()

    started = await service.http.post("/internal/v1/replay", headers=service.as_service())
    assert started.status_code == 202, started.text
    replay = started.json()
    new = replay["generation"]
    assert new > old
    assert replay["status"] == "BUILDING"
    assert started.headers["location"] == f"/internal/v1/replay/{new}"

    again = await service.http.post("/internal/v1/replay", headers=service.as_service())
    assert again.status_code == 409
    assert again.json()["type"] == "urn:lotou:problem:replay-in-progress"

    # Enquanto a geração nova é montada, a API continua respondendo, e com os dados completos.
    reads_while_building = 0

    async def switched() -> bool:
        nonlocal reads_while_building
        status = (await service.http.get(f"/internal/v1/replay/{new}", headers=service.as_service())).json()
        assert status["status"] in ("BUILDING", "ACTIVE"), status
        response = await service.http.get(sales_url, headers=service.as_producer(a))
        assert response.status_code == 200
        assert response.json() == sales_before
        if status["status"] == "BUILDING":
            reads_while_building += 1
        return bool(status["status"] == "ACTIVE")

    await eventually(switched, "o replay não terminou")
    assert reads_while_building >= 3
    monkeypatch.undo()

    finished = (await service.http.get(f"/internal/v1/replay/{new}", headers=service.as_service())).json()
    assert finished["eventsApplied"] > 0
    assert {offset["topic"] for offset in finished["endOffsets"]} == set(TOPICS)
    assert await service.registry.active_generation() == new

    # O critério da fase: a geração reconstruída é igual à original, documento a documento.
    after = await snapshot(service.db, new)
    assert_same(before, after)
    assert sum(len(docs) for docs in after.values()) > 0

    # As views sem sufixo apontam para a geração nova.
    assert await service.db["order_view"].find().sort("_id", 1).to_list(None) == after["order_view"]

    # O consumidor ao vivo passa para a geração nova e a antiga é apagada depois da carência.
    async def old_dropped() -> bool:
        generation = await service.registry.get(old)
        return generation is not None and generation.status == GenerationStatus.DROPPED

    await eventually(old_dropped, "a geração antiga não foi apagada")
    assert service.supervisor.generation == new
    names = set(await service.db.list_collection_names())
    assert not any(collection_name(base, old) in names for base in ALL_COLLECTIONS)
    admin = AIOKafkaAdminClient(bootstrap_servers=service.settings.kafka_brokers)
    await admin.start()
    try:
        groups = {group[0] for group in await admin.list_consumer_groups()}
    finally:
        await admin.close()
    assert service.registry.group_id(old) not in groups
    assert service.registry.group_id(new) in groups

    # Eventos novos entram na geração nova, contados uma vez só.
    o7 = OrderSpec(
        id=str(uuid.uuid4()),
        show_id=a.id,
        buyer_id=str(uuid.uuid4()),
        reservation_id=str(uuid.uuid4()),
        sector=scenario.plateia,
        lot=scenario.lot_plateia,
        seats=("B-1",),
    )
    await service.publish([o7.created(at(20, 30)), o7.confirmed(at(20, 31))])
    await service.caught_up()
    statement = (await service.http.get(f"/v1/analytics/shows/{a.id}/statement", headers=service.as_producer(a))).json()
    assert (statement["confirmedOrders"], statement["grossSalesCents"]) == (4, 128000 + 16000)


async def test_events_published_during_a_replay_are_not_lost(service: Service) -> None:
    """Replay pela linha de comando (outro "processo") com eventos chegando ao mesmo tempo.

    Depois, um segundo replay sem tráfego reconstrói tudo de novo: se algum evento
    publicado durante o primeiro tivesse se perdido ou sido contado duas vezes na
    troca de geração, as duas gerações seriam diferentes.
    """
    await service.caught_up()
    scenario = build()
    replay = asyncio.create_task(run_replay_cli(service.settings))
    await service.publish(scenario.all_in_publish_order(), pause=0.02)
    assert await replay == 0
    await service.caught_up()

    a = scenario.show_a
    statement = (await service.http.get(f"/v1/analytics/shows/{a.id}/statement", headers=service.as_producer(a))).json()
    assert (statement["grossSalesCents"], statement["confirmedOrders"], statement["cancelledOrders"]) == (128000, 3, 2)

    first = await service.registry.active_generation()
    assert first is not None
    assert await run_replay_cli(service.settings) == 0
    await service.caught_up()
    second = await service.registry.active_generation()
    assert second is not None
    assert second > first

    assert_same(await snapshot(service.db, first), await snapshot(service.db, second))


async def test_failed_replay_keeps_the_active_generation(service: Service, monkeypatch: pytest.MonkeyPatch) -> None:
    await service.caught_up()
    active = await service.registry.active_generation()

    # Um tópico que não existe: o replay não pode reconstruir sem ele.
    monkeypatch.setattr("analytics.kafka.consumer.TOPICS", (*TOPICS, "topico.inexistente"))
    assert await run_replay_cli(service.settings) == 1

    assert await service.registry.active_generation() == active
    failed = await service.registry.latest("replay")
    assert failed is not None
    assert failed.status in (GenerationStatus.FAILED, GenerationStatus.DROPPED)
    assert "tópicos inexistentes" in (failed.error or "")
    # O lock foi liberado: outro replay pode rodar.
    monkeypatch.undo()
    assert await run_replay_cli(service.settings) == 0

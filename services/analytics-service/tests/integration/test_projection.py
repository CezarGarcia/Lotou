"""Projeções contra um MongoDB real: idempotência e independência da ordem de chegada."""

import asyncio
import random
from datetime import timedelta
from typing import Any

import pytest
from pymongo.asynchronous.client_session import AsyncClientSession
from pymongo.asynchronous.mongo_client import AsyncMongoClient

from analytics.contracts import parse
from analytics.projection import Outcome, Projector, Source
from analytics.store.read_models import ReadModels, create_indexes
from tests import events
from tests.events import Message
from tests.readmodels import assert_same, snapshot
from tests.scenario import Scenario, at, build

Client = AsyncMongoClient[dict[str, Any]]


async def apply_all(client: Client, projector: Projector, messages: list[Message]) -> list[Outcome]:
    outcomes = []
    for offset, message in enumerate(messages):
        event = parse(message.raw())
        assert event is not None

        source = Source(message.topic, 0, offset)

        async def apply(session: AsyncClientSession, event: Any = event, source: Source = source) -> Outcome:
            return await projector.apply(event, source, session)

        async with client.start_session() as session:
            outcomes.append(await session.with_transaction(apply))
    return outcomes


@pytest.fixture
async def setup(mongo_client: Client, database_name: str) -> Any:
    db = mongo_client[database_name]
    counter = iter(range(1, 1000))

    async def new_projector() -> Projector:
        generation = next(counter)
        await create_indexes(db, generation, processed_ttl=timedelta(days=1))
        return Projector(db, generation)

    yield db, new_projector
    await mongo_client.drop_database(database_name)


async def test_scenario_builds_the_expected_read_models(mongo_client: Client, setup: Any) -> None:
    _db, new_projector = setup
    scenario = build()
    projector = await new_projector()
    await apply_all(mongo_client, projector, scenario.messages)
    models = projector.models
    a, b = scenario.show_a.id, scenario.show_b.id

    show = await models.shows.find_one({"_id": a})
    assert (show["version"], show["title"]) == (3, scenario.new_title)  # a v2 republicada depois foi ignorada

    statement = await models.statements.find_one({"_id": a})
    assert statement["producerId"] == scenario.show_a.producer_id
    assert statement["grossSalesCents"] == 2 * 16000 + 3 * 12000 + 4 * 15000
    assert statement["receivableCents"] == statement["grossSalesCents"]
    assert (statement["confirmedOrders"], statement["ticketsSold"], statement["ticketsIssued"]) == (3, 9, 5)
    assert statement["cancelledOrders"] == 2
    assert statement["cancelledByReason"] == {"PAYMENT_DECLINED": 1, "RESERVATION_EXPIRED": 1}
    assert statement["ordersCreated"] == 5
    assert statement["partial"] is True
    assert statement["show"]["title"] == scenario.new_title

    # O pedido do show B chegou antes do show: o título foi preenchido depois.
    o6 = await models.orders.find_one({"_id": scenario.orders["o6"].id})
    assert o6["show"]["title"] == "Samba de Quinta"
    assert (await models.statements.find_one({"_id": b}))["producerId"] == scenario.show_b.producer_id

    # O título mudou na v3: os pedidos já gravados acompanham.
    o1 = await models.orders.find_one({"_id": scenario.orders["o1"].id})
    assert o1["show"]["title"] == scenario.new_title
    assert o1["status"] == "CONFIRMED"
    assert [entry["status"] for entry in o1["timeline"]] == ["CREATED", "CONFIRMED", "TICKETS_ISSUED"]

    sales = await models.sales.find({"showId": a}).sort("_id", 1).to_list(None)
    by_key = {(doc["sectorId"], doc["hour"]): doc for doc in sales}
    assert by_key[(scenario.plateia.id, at(18))]["ticketsSold"] == 2
    assert by_key[(scenario.pista.id, at(18))]["lots"] == {scenario.lot1.id: {"ticketsSold": 3, "revenueCents": 36000}}
    assert by_key[(scenario.pista.id, at(19))]["revenueCents"] == 60000
    assert len(sales) == 3

    lot1 = await models.lots.find_one({"_id": f"{a}:{scenario.lot1.id}"})
    assert [entry["type"] for entry in lot1["transitions"]] == ["OPENED", "SOLD_OUT"]


async def test_repeated_events_change_nothing(mongo_client: Client, setup: Any) -> None:
    db, new_projector = setup
    scenario = build()
    projector = await new_projector()
    assert set(await apply_all(mongo_client, projector, scenario.messages)) == {Outcome.APPLIED}
    before = await snapshot(db, projector.generation)

    again = await apply_all(mongo_client, projector, scenario.messages)

    assert set(again) == {Outcome.DUPLICATE}
    assert_same(before, await snapshot(db, projector.generation))


@pytest.mark.parametrize("seed", range(8))
async def test_any_arrival_order_gives_the_same_read_models(mongo_client: Client, setup: Any, seed: int) -> None:
    """A ordem só é garantida por chave; aqui nem isso: tudo embaralhado, com repetições."""
    db, new_projector = setup
    scenario: Scenario = build()
    in_order = await new_projector()
    await apply_all(mongo_client, in_order, scenario.messages)

    rng = random.Random(seed)
    shuffled = scenario.messages + rng.sample(scenario.messages, k=6)
    rng.shuffle(shuffled)
    out_of_order = await new_projector()
    await apply_all(mongo_client, out_of_order, shuffled)

    assert_same(await snapshot(db, in_order.generation), await snapshot(db, out_of_order.generation))


async def test_order_and_show_arriving_together_never_leave_the_title_behind(mongo_client: Client, setup: Any) -> None:
    """A transação que cria o order_view e a do catálogo gravam o mesmo documento do
    relatório, então o MongoDB não deixa as duas passarem juntas com leituras velhas."""
    _, new_projector = setup
    projector = await new_projector()
    for _ in range(15):
        scenario = build()
        show = events.show_event(scenario.show_a, version=1, status="ON_SALE", at=at(15), event_type="ShowPublished")
        order = scenario.orders["o1"].created(at(18))
        await asyncio.gather(
            apply_all(mongo_client, projector, [order]),
            apply_all(mongo_client, projector, [show]),
        )
        view = await projector.models.orders.find_one({"_id": scenario.orders["o1"].id})
        assert view["show"] is not None
        assert view["show"]["title"] == scenario.show_a.title


async def test_lot_timeline_is_ordered_by_the_time_of_the_fact(mongo_client: Client, setup: Any) -> None:
    _, new_projector = setup
    scenario = build()
    projector = await new_projector()
    sold_out = events.lot_sold_out(scenario.show_a, scenario.pista, scenario.lot1, at(19, 20))
    opened = events.lot_opened(scenario.show_a, scenario.pista, scenario.lot1, at(15))
    reopened = events.lot_opened(scenario.show_a, scenario.pista, scenario.lot1, at(19, 40))
    await apply_all(mongo_client, projector, [reopened, sold_out, opened])

    models: ReadModels = projector.models
    doc = await models.lots.find_one({"_id": f"{scenario.show_a.id}:{scenario.lot1.id}"})
    assert [(entry["type"], entry["at"]) for entry in doc["transitions"]] == [
        ("OPENED", at(15)),
        ("SOLD_OUT", at(19, 20)),
        ("OPENED", at(19, 40)),
    ]

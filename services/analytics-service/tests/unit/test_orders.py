"""Projeção do pedido: tabela de transições, fatos atrasados e o que vai para o relatório."""

import itertools
from datetime import UTC, datetime

import pytest

from analytics.contracts import Event, parse
from analytics.domain import hour_bucket
from analytics.domain.orders import TRANSITIONS, OrderStatus, SaleLine, Step, apply, sale_lines, step
from tests import events
from tests.events import Message
from tests.scenario import at, build

PENDING, CONFIRMED, CANCELLED = OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.CANCELLED


def event(message: Message) -> Event:
    parsed = parse(message.raw())
    assert parsed is not None
    return parsed


@pytest.mark.parametrize(
    ("current", "reached", "expected"),
    [
        (None, PENDING, Step.ENTERED),
        (None, CONFIRMED, Step.ENTERED),
        (None, CANCELLED, Step.ENTERED),
        (PENDING, CONFIRMED, Step.ENTERED),
        (PENDING, CANCELLED, Step.ENTERED),
        (PENDING, PENDING, Step.REPEATED),
        (CONFIRMED, CONFIRMED, Step.REPEATED),
        (CONFIRMED, PENDING, Step.LATE),
        (CANCELLED, PENDING, Step.LATE),
        (CONFIRMED, CANCELLED, Step.REFUSED),
        (CANCELLED, CONFIRMED, Step.REFUSED),
    ],
)
def test_step_follows_the_transition_table(current: OrderStatus | None, reached: OrderStatus, expected: Step) -> None:
    assert step(current, reached) is expected


def test_final_states_have_no_way_out() -> None:
    assert TRANSITIONS[CONFIRMED] == frozenset()
    assert TRANSITIONS[CANCELLED] == frozenset()


def test_created_confirmed_and_issued_build_the_order() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    show = {"title": "Vinte Anos de Estrada"}

    created = apply(None, event(o1.created(at(18))), show)
    assert created.step is Step.ENTERED
    assert created.view["status"] == "PENDING"
    assert created.view["show"] == show
    assert created.statement.orders_created == 1
    assert created.sales == []

    confirmed = apply(created.view, event(o1.confirmed(at(18, 0, 2))), None)
    assert confirmed.view["status"] == "CONFIRMED"
    assert confirmed.statement.orders_created == 0
    assert confirmed.statement.confirmed_orders == 1
    assert confirmed.statement.tickets_sold == 2
    assert confirmed.statement.gross_sales_cents == 32000
    assert confirmed.sales == [SaleLine(o1.sector.id, o1.lot.id, 2, 32000)]
    assert confirmed.sold_at == at(18, 0, 2)

    issued = apply(confirmed.view, event(o1.tickets_issued(at(18, 0, 3))), None)
    assert [ticket["seat"] for ticket in issued.view["tickets"]] == ["A-5", "A-6"]
    assert issued.statement.tickets_issued == 2
    assert [entry["status"] for entry in issued.view["timeline"]] == ["CREATED", "CONFIRMED", "TICKETS_ISSUED"]


def test_view_does_not_depend_on_arrival_order() -> None:
    scenario = build()
    o2 = scenario.orders["o2"]
    facts = [event(o2.created(at(18, 10))), event(o2.confirmed(at(18, 11))), event(o2.tickets_issued(at(18, 12)))]

    results = []
    for permutation in itertools.permutations(facts):
        view = None
        totals = {"created": 0, "confirmed": 0, "gross": 0, "issued": 0}
        for fact in permutation:
            change = apply(view, fact, None)
            view = change.view
            totals["created"] += change.statement.orders_created
            totals["confirmed"] += change.statement.confirmed_orders
            totals["gross"] += change.statement.gross_sales_cents
            totals["issued"] += change.statement.tickets_issued
        results.append((view, totals))

    first_view, first_totals = results[0]
    assert first_view is not None
    assert first_view["status"] == "CONFIRMED"
    assert first_totals == {"created": 1, "confirmed": 1, "gross": 36000, "issued": 3}
    for view, totals in results[1:]:
        assert view == first_view
        assert totals == first_totals


def test_same_fact_with_another_event_id_is_not_counted_twice() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    first = apply(None, event(o1.confirmed(at(18, 0, 2))), None)
    again = apply(first.view, event(o1.confirmed(at(18, 0, 2))), None)
    assert again.step is Step.REPEATED
    assert again.statement.is_empty()
    assert again.sales == []
    assert again.view == first.view


def test_cancellation_after_confirmation_is_refused() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    confirmed = apply(None, event(o1.confirmed(at(18, 0, 2))), None)
    refused = apply(confirmed.view, event(o1.cancelled(at(18, 5), "RESERVATION_EXPIRED")), None)
    assert refused.step is Step.REFUSED
    assert refused.view == confirmed.view
    assert refused.statement.is_empty()


def test_cancellation_counts_the_reason() -> None:
    scenario = build()
    o3 = scenario.orders["o3"]
    created = apply(None, event(o3.created(at(18, 20))), None)
    cancelled = apply(created.view, event(o3.cancelled(at(18, 20, 5), "PAYMENT_DECLINED")), None)
    assert cancelled.view["status"] == "CANCELLED"
    assert cancelled.view["cancelReason"] == "PAYMENT_DECLINED"
    assert cancelled.statement.cancelled_orders == 1
    assert cancelled.statement.cancelled_reason == "PAYMENT_DECLINED"
    assert cancelled.statement.gross_sales_cents == 0


def test_tickets_are_issued_once() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    first = apply(None, event(o1.tickets_issued(at(18, 0, 3))), None)
    second = apply(first.view, event(o1.tickets_issued(at(18, 0, 4))), None)
    assert second.statement.tickets_issued == 0
    assert second.view == first.view


def test_sale_lines_group_items_by_sector_and_lot() -> None:
    scenario = build()
    message = scenario.orders["o5"].confirmed(at(19, 31))
    payload = event(message).payload
    assert hasattr(payload, "items")
    assert sale_lines(payload.items) == [SaleLine(scenario.pista.id, scenario.lot2.id, 4, 60000)]


def test_hour_bucket_is_the_utc_hour() -> None:
    assert hour_bucket(datetime(2026, 11, 26, 18, 59, 59, 999000, tzinfo=UTC)) == datetime(2026, 11, 26, 18, tzinfo=UTC)


def test_order_items_keep_money_as_integer_cents() -> None:
    scenario = build()
    change = apply(None, event(scenario.orders["o1"].confirmed(at(18))), None)
    assert all(isinstance(item["unitPriceCents"], int) for item in change.view["items"])
    assert isinstance(change.view["totalCents"], int)


def test_messages_built_by_the_tests_follow_the_contracts() -> None:
    # As fábricas validam contra o JSON Schema ao montar; isto só garante que nada escapa.
    scenario = build()
    for message in scenario.messages:
        events.validator(message.topic, message.type).validate(message.value)

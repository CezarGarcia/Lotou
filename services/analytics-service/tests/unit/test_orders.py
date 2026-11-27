"""Projeção do pedido: tabela de transições, fatos atrasados e o que vai para o relatório."""

import itertools
from datetime import UTC, datetime

import pytest

from analytics.contracts import Event, parse
from analytics.domain import hour_bucket
from analytics.domain.orders import (
    FACTS,
    TRANSITIONS,
    OrderStatus,
    SaleLine,
    SalesChange,
    Step,
    TicketStatus,
    apply,
    sale_lines,
    step,
    ticket_status,
)
from tests import events
from tests.events import Message
from tests.scenario import at, build

PENDING, CONFIRMED, CANCELLED = OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.CANCELLED
REFUNDING, REFUND_FAILED, REFUNDED = OrderStatus.REFUNDING, OrderStatus.REFUND_FAILED, OrderStatus.REFUNDED


def event(message: Message) -> Event:
    parsed = parse(message.raw())
    assert parsed is not None
    return parsed


@pytest.mark.parametrize(
    ("current", "fact", "expected"),
    [
        (None, "OrderCreated", Step.ENTERED),
        (None, "OrderConfirmed", Step.ENTERED),
        (None, "OrderCancelled", Step.ENTERED),
        (None, "OrderRefunded", Step.ENTERED),
        (PENDING, "OrderConfirmed", Step.ENTERED),
        (PENDING, "OrderCancelled", Step.ENTERED),
        (PENDING, "OrderCreated", Step.REPEATED),
        (CONFIRMED, "OrderConfirmed", Step.REPEATED),
        (CONFIRMED, "OrderCreated", Step.LATE),
        (CANCELLED, "OrderCreated", Step.LATE),
        (CONFIRMED, "OrderCancelled", Step.REFUSED),
        (CANCELLED, "OrderConfirmed", Step.REFUSED),
        (CONFIRMED, "TicketsCancelled", Step.ENTERED),
        (REFUNDING, "OrderRefunded", Step.ENTERED),
        (REFUNDING, "OrderRefundFailed", Step.ENTERED),
        # Reprocessamento manual (REFUND_FAILED -> REFUNDING) não tem evento: o estorno leva adiante.
        (REFUND_FAILED, "OrderRefunded", Step.ENTERED),
        (REFUND_FAILED, "OrderRefundFailed", Step.REPEATED),
        # O cancelamento dos ingressos é anterior à falha, mesmo com o ciclo da tabela.
        (REFUND_FAILED, "TicketsCancelled", Step.LATE),
        (REFUNDED, "OrderConfirmed", Step.LATE),
        (REFUNDED, "TicketsCancelled", Step.LATE),
        (REFUNDED, "OrderRefundFailed", Step.LATE),
        # À frente: o cancelamento dos ingressos ainda não chegou.
        (CONFIRMED, "OrderRefunded", Step.ENTERED),
        (PENDING, "TicketsCancelled", Step.ENTERED),
        (CANCELLED, "TicketsCancelled", Step.REFUSED),
        (CANCELLED, "OrderRefunded", Step.REFUSED),
        (REFUNDED, "OrderCancelled", Step.REFUSED),
    ],
)
def test_step_follows_the_transition_table(current: OrderStatus | None, fact: str, expected: Step) -> None:
    assert step(current, FACTS[fact]) is expected


def test_final_states_have_no_way_out() -> None:
    assert TRANSITIONS[CANCELLED] == frozenset()
    assert TRANSITIONS[REFUNDED] == frozenset()
    assert TRANSITIONS[CONFIRMED] == frozenset({REFUNDING})
    assert TRANSITIONS[REFUND_FAILED] == frozenset({REFUNDING})


def test_created_confirmed_and_issued_build_the_order() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    show = {"title": "Vinte Anos de Estrada"}

    created = apply(None, event(o1.created(at(18))), show)
    assert created.step is Step.ENTERED
    assert created.view["status"] == "PENDING"
    assert created.view["show"] == show
    assert created.statement.orders_created == 1
    assert created.sales is None

    confirmed = apply(created.view, event(o1.confirmed(at(18, 0, 2))), None)
    assert confirmed.view["status"] == "CONFIRMED"
    assert confirmed.first_time
    assert confirmed.statement.orders_created == 0
    assert confirmed.statement.confirmed_orders == 1
    assert confirmed.statement.tickets_sold == 2
    assert confirmed.statement.gross_sales_cents == 32000
    # O show A repassa a taxa ao comprador: ela não sai do valor a receber.
    assert (confirmed.statement.buyer_fees_cents, confirmed.statement.platform_fee_cents) == (3200, 0)
    assert confirmed.sales == SalesChange(at(18, 0, 2), [SaleLine(o1.sector.id, o1.lot.id, 2, 32000)], orders=1)
    assert (confirmed.view["subtotalCents"], confirmed.view["totalCents"]) == (32000, 35200)

    issued = apply(confirmed.view, event(o1.tickets_issued(at(18, 0, 3))), None)
    assert [ticket["seat"] for ticket in issued.view["tickets"]] == ["A-5", "A-6"]
    assert {ticket["status"] for ticket in issued.view["tickets"]} == {"VALID"}
    assert issued.statement.tickets_issued == 2
    assert [entry["status"] for entry in issued.view["timeline"]] == ["CREATED", "CONFIRMED", "TICKETS_ISSUED"]


def _apply_all(facts: tuple[Event, ...]) -> tuple[dict, dict[str, int], list[SalesChange]]:
    view = None
    totals: dict[str, int] = {}
    sales: list[SalesChange] = []
    for fact in facts:
        change = apply(view, fact, None)
        view = change.view
        for name, value in vars(change.statement).items():
            if isinstance(value, int):
                totals[name] = totals.get(name, 0) + value
        if change.sales is not None:
            sales.append(change.sales)
    assert view is not None
    return view, totals, sales


def _net_sales(sales: list[SalesChange]) -> dict[tuple[datetime, str, str], tuple[int, int, int]]:
    """O que as vendas por setor acumulam, por hora, setor e lote (pedidos, ingressos, receita)."""
    result: dict[tuple[datetime, str, str], tuple[int, int, int]] = {}
    for change in sales:
        for line in change.lines:
            key = (hour_bucket(change.sold_at), line.sector_id, line.lot_id)
            orders, tickets, revenue = result.get(key, (0, 0, 0))
            result[key] = (orders + change.orders, tickets + line.tickets, revenue + line.revenue_cents)
    return result


def test_view_does_not_depend_on_arrival_order() -> None:
    scenario = build()
    o2 = scenario.orders["o2"]
    facts = [event(o2.created(at(18, 10))), event(o2.confirmed(at(18, 11))), event(o2.tickets_issued(at(18, 12)))]

    results = [_apply_all(permutation) for permutation in itertools.permutations(facts)]
    first_view, first_totals, first_sales = results[0]
    assert first_view["status"] == "CONFIRMED"
    assert (first_totals["orders_created"], first_totals["confirmed_orders"]) == (1, 1)
    assert (first_totals["gross_sales_cents"], first_totals["tickets_issued"]) == (36000, 3)
    for view, totals, sales in results[1:]:
        assert view == first_view
        assert totals == first_totals
        assert _net_sales(sales) == _net_sales(first_sales)


def test_refund_cycle_does_not_depend_on_arrival_order() -> None:
    """Compra com cupom, ingressos emitidos, um usado, falha de estorno e estorno, em qualquer ordem."""
    scenario = build()
    o8 = scenario.orders["o8"]  # show B: o produtor absorve a taxa; cupom de 15%
    facts = [
        event(o8.created(at(19))),
        event(o8.confirmed(at(19, 0, 5))),
        event(o8.tickets_issued(at(19, 0, 6))),
        event(o8.tickets_cancelled(at(20), reason="SHOW_CANCELLED")),
        event(o8.refund_failed(at(20, 30))),
        event(o8.refunded(at(21), reason="SHOW_CANCELLED")),
    ]
    results = [_apply_all(permutation) for permutation in itertools.permutations(facts)]

    view, totals, sales = results[0]
    assert view["status"] == "REFUNDED"
    assert (view["refundedCents"], view["refundReason"], view["refundAttempts"]) == (22950, "SHOW_CANCELLED", 5)
    assert [entry["status"] for entry in view["timeline"]] == [
        "CREATED",
        "CONFIRMED",
        "TICKETS_ISSUED",
        "REFUNDING",
        "REFUND_FAILED",
        "REFUNDED",
    ]
    assert {ticket["status"] for ticket in view["tickets"]} == {"CANCELLED"}
    # Vendido, com desconto e taxa absorvida; o estorno devolve tudo e tira a taxa do produtor.
    assert totals["gross_sales_cents"] == 27000
    assert totals["discounts_cents"] == 4050
    assert totals["refunds_cents"] == 27000 - 4050
    assert totals["platform_fee_cents"] == 0
    assert (totals["tickets_sold"], totals["tickets_refunded"], totals["refunded_orders"]) == (3, 3, 1)
    # Nas vendas por setor, o pedido reembolsado some da hora em que foi vendido.
    assert _net_sales(sales) == {(at(19), o8.sector.id, o8.lot.id): (0, 0, 0)}
    for other_view, other_totals, other_sales in results[1:]:
        assert other_view == view
        assert other_totals == totals
        assert _net_sales(other_sales) == _net_sales(sales)


def test_same_fact_with_another_event_id_is_not_counted_twice() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    first = apply(None, event(o1.confirmed(at(18, 0, 2))), None)
    again = apply(first.view, event(o1.confirmed(at(18, 0, 2))), None)
    assert again.step is Step.REPEATED
    assert again.statement.is_empty()
    assert again.sales is None
    assert not again.first_time
    assert again.view == first.view

    refunded = apply(first.view, event(o1.refunded(at(19))), None)
    refunded_again = apply(refunded.view, event(o1.refunded(at(19))), None)
    assert refunded.statement.refunded_orders == 1
    assert refunded_again.statement.is_empty()
    assert refunded_again.sales is None


def test_cancellation_after_confirmation_is_refused() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    confirmed = apply(None, event(o1.confirmed(at(18, 0, 2))), None)
    refused = apply(confirmed.view, event(o1.cancelled(at(18, 5), "RESERVATION_EXPIRED")), None)
    assert refused.step is Step.REFUSED
    assert refused.view == confirmed.view
    assert refused.statement.is_empty()


def test_refund_of_a_cancelled_order_is_refused() -> None:
    scenario = build()
    o3 = scenario.orders["o3"]
    cancelled = apply(None, event(o3.cancelled(at(18, 20, 5), "PAYMENT_DECLINED")), None)
    refused = apply(cancelled.view, event(o3.refunded(at(19))), None)
    assert refused.step is Step.REFUSED
    assert refused.statement.is_empty()
    assert refused.view == cancelled.view


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


def test_check_in_marks_the_ticket_used_once_even_before_it_is_issued() -> None:
    scenario = build()
    o1 = scenario.orders["o1"]
    entered = apply(None, event(o1.checked_in(1, "Portão B", at(22, 2))), None)
    # O documento nasce pela entrada (outro tópico, outra ordem), mas o relatório
    # só conta o pedido no primeiro fato do order.events.
    assert entered.statement.is_empty()
    assert entered.checkin is not None
    assert entered.checkin.gate == "Portão B"
    assert entered.first_time

    again = apply(entered.view, event(o1.checked_in(1, "Portão C", at(22, 5))), None)
    assert again.checkin is None
    assert not again.first_time

    issued = apply(again.view, event(o1.tickets_issued(at(18, 0, 3))), None)
    assert issued.statement.orders_created == 1
    tickets = {ticket["ticketId"]: ticket for ticket in issued.view["tickets"]}
    used = tickets[o1.ticket_ids[1]]
    assert (used["status"], used["gate"], used["usedAt"]) == ("USED", "Portão B", at(22, 2))
    assert tickets[o1.ticket_ids[0]]["status"] == "VALID"


@pytest.mark.parametrize(
    ("checked_in_at", "cancelled_at", "expected"),
    [
        (at(20), None, TicketStatus.USED),
        (None, at(20), TicketStatus.CANCELLED),
        (None, None, TicketStatus.VALID),
        # Entrou antes do cancelamento: usado não é cancelado.
        (at(19), at(20), TicketStatus.USED),
        # Cancelado antes da entrada: a entrada é recusada pela tabela.
        (at(21), at(20), TicketStatus.CANCELLED),
    ],
)
def test_ticket_status_follows_its_table_in_the_order_of_the_facts(
    checked_in_at: datetime | None, cancelled_at: datetime | None, expected: TicketStatus
) -> None:
    checkin = {"at": checked_in_at, "gate": "A"} if checked_in_at else None
    assert ticket_status(checkin, cancelled_at)[0] is expected


def test_sale_lines_take_the_coupon_discount() -> None:
    scenario = build()
    message = scenario.orders["o5"].confirmed(at(19, 31))
    payload = event(message).payload
    assert hasattr(payload, "items")
    assert sale_lines(payload.items, 0) == [SaleLine(scenario.pista.id, scenario.lot2.id, 4, 60000)]
    assert sale_lines(payload.items, 5000) == [SaleLine(scenario.pista.id, scenario.lot2.id, 4, 55000)]


def test_discount_is_split_between_lines_in_proportion_and_keeps_every_cent() -> None:
    o1 = build().orders["o1"]
    items = [
        *event(o1.confirmed(at(18))).payload.items,  # type: ignore[union-attr]
        *event(build().orders["o2"].confirmed(at(18))).payload.items,  # type: ignore[union-attr]
    ]
    lines = sale_lines(items, 1001)
    # 32000 e 36000 de 68000: 471,06 e 529,94 → 471 e 529, e o centavo que sobra vai para a primeira.
    assert [line.revenue_cents for line in lines] == [32000 - 472, 36000 - 529]
    assert sum(line.revenue_cents for line in lines) == 68000 - 1001


def test_hour_bucket_is_the_utc_hour() -> None:
    assert hour_bucket(datetime(2026, 11, 26, 18, 59, 59, 999000, tzinfo=UTC)) == datetime(2026, 11, 26, 18, tzinfo=UTC)


def test_order_items_keep_money_as_integer_cents() -> None:
    scenario = build()
    change = apply(None, event(scenario.orders["o1"].confirmed(at(18))), None)
    assert all(isinstance(item["unitPriceCents"], int) for item in change.view["items"])
    for field in ("totalCents", "subtotalCents", "discountCents", "serviceFeeCents"):
        assert isinstance(change.view[field], int)


def test_messages_built_by_the_tests_follow_the_contracts() -> None:
    # As fábricas validam contra o JSON Schema ao montar; isto só garante que nada escapa.
    scenario = build()
    for message in scenario.messages:
        events.validator(message.topic, message.type).validate(message.value)

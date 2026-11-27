"""Relatório do produtor: valor a receber e relatório parcial."""

from datetime import UTC, datetime

import pytest

from analytics.domain import statement
from analytics.domain.orders import StatementDelta

SHOW = {
    "_id": "s",
    "producerId": "p",
    "status": "ON_SALE",
    "title": "Vinte Anos de Estrada",
    "artist": "Os Tropicais do Asfalto",
    "startsAt": datetime(2026, 12, 16, 23, 30, tzinfo=UTC),
    "venue": {"name": "Teatro Guanabara", "city": "Rio de Janeiro", "timezone": "America/Sao_Paulo"},
}


def test_new_statement_is_zeroed_and_partial() -> None:
    current = statement.new("s")
    assert current["grossSalesCents"] == 0
    assert current["receivableCents"] == 0
    assert current["discountsCents"] == current["refundsCents"] == current["platformFeeCents"] == 0
    assert current["currency"] == "BRL"
    assert current["partial"] is True


@pytest.mark.parametrize(
    ("gross", "discounts", "refunds", "fee", "expected"),
    [(128000, 0, 0, 0, 128000), (128000, 5000, 16000, 12800, 94200), (0, 0, 0, 0, 0)],
)
def test_receivable_is_gross_minus_discounts_refunds_and_fee(
    gross: int, discounts: int, refunds: int, fee: int, expected: int
) -> None:
    assert statement.receivable_cents(gross, discounts, refunds, fee) == expected


def test_add_sums_the_delta_and_keeps_the_latest_event_time() -> None:
    current = statement.new("s")
    statement.add(
        current,
        StatementDelta(orders_created=1, confirmed_orders=1, tickets_sold=2, gross_sales_cents=32000),
        datetime(2026, 11, 26, 18, tzinfo=UTC),
    )
    statement.add(
        current,
        StatementDelta(orders_created=1, cancelled_orders=1, cancelled_reason="PAYMENT_DECLINED"),
        datetime(2026, 11, 26, 17, tzinfo=UTC),
    )
    assert current["grossSalesCents"] == 32000
    assert current["receivableCents"] == 32000
    assert current["ordersCreated"] == 2
    assert current["cancelledByReason"] == {"PAYMENT_DECLINED": 1}
    assert current["lastEventAt"] == datetime(2026, 11, 26, 18, tzinfo=UTC)


def test_reasons_are_kept_in_alphabetical_order() -> None:
    current = statement.new("s")
    at = datetime(2026, 11, 26, tzinfo=UTC)
    statement.add(current, StatementDelta(cancelled_orders=1, cancelled_reason="RESERVATION_EXPIRED"), at)
    statement.add(current, StatementDelta(cancelled_orders=1, cancelled_reason="PAYMENT_DECLINED"), at)
    assert list(current["cancelledByReason"]) == ["PAYMENT_DECLINED", "RESERVATION_EXPIRED"]


@pytest.mark.parametrize(
    ("status", "partial"),
    [("PUBLISHED", True), ("ON_SALE", True), ("SALES_CLOSED", True), ("CANCELLED", True), ("FINISHED", False)],
)
def test_statement_is_final_only_when_the_show_finished(status: str, partial: bool) -> None:
    current = statement.new("s")
    statement.attach_show(current, SHOW | {"status": status})
    assert current["partial"] is partial
    assert current["producerId"] == "p"
    assert current["show"]["status"] == status


def test_refunded_order_nets_to_zero_in_the_receivable() -> None:
    """Pedido de 3 x 90,00 com cupom de 15% num show em que o produtor absorve a taxa."""
    current = statement.new("s")
    at = datetime(2026, 11, 26, 19, tzinfo=UTC)
    sold = StatementDelta(
        confirmed_orders=1,
        tickets_sold=3,
        gross_sales_cents=27000,
        discounts_cents=4050,
        platform_fee_cents=2700,
    )
    statement.add(current, sold, at)
    assert current["receivableCents"] == 27000 - 4050 - 2700

    refund = StatementDelta(refunded_orders=1, refunds_cents=27000 - 4050, platform_fee_cents=-2700, tickets_refunded=3)
    statement.add(current, refund, at)
    assert (current["grossSalesCents"], current["discountsCents"]) == (27000, 4050)
    assert (current["refundsCents"], current["platformFeeCents"], current["receivableCents"]) == (22950, 0, 0)
    assert statement.net_tickets(current) == 0
    assert statement.net_revenue_cents(current) == 0


def test_buyer_fees_are_informative() -> None:
    current = statement.new("s")
    statement.add(
        current,
        StatementDelta(confirmed_orders=1, gross_sales_cents=32000, buyer_fees_cents=3200),
        datetime(2026, 11, 26, tzinfo=UTC),
    )
    assert current["buyerFeesCents"] == 3200
    assert current["receivableCents"] == 32000


def test_statement_saved_before_phase_6_gets_the_new_fields() -> None:
    old = statement.new("s")
    for field in ("buyerFeesCents", "refundedOrders", "ticketsRefunded"):
        del old[field]
    statement.add(old, StatementDelta(refunded_orders=1, refunds_cents=100), datetime(2026, 11, 26, tzinfo=UTC))
    assert (old["buyerFeesCents"], old["refundedOrders"], old["ticketsRefunded"]) == (0, 1, 0)
    assert old["receivableCents"] == -100

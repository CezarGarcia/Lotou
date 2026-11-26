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

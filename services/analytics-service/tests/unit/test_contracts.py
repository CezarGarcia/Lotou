"""O consumidor lê os exemplos de `contracts/examples/` e trata o que está fora do contrato."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from analytics import contracts
from analytics.contracts import (
    TOPICS,
    ContractError,
    LotOpened,
    LotSoldOut,
    OrderCancelled,
    OrderConfirmed,
    OrderCreated,
    OrderRefunded,
    OrderRefundFailed,
    ShowSnapshot,
    TicketCheckedIn,
    TicketsCancelled,
    TicketsIssued,
    parse,
)
from tests.events import CONTRACTS, validator

EXPECTED_MODEL = {
    "ShowPublished": ShowSnapshot,
    "ShowUpdated": ShowSnapshot,
    "OrderCreated": OrderCreated,
    "OrderConfirmed": OrderConfirmed,
    "OrderCancelled": OrderCancelled,
    "TicketsIssued": TicketsIssued,
    "TicketsCancelled": TicketsCancelled,
    "OrderRefunded": OrderRefunded,
    "OrderRefundFailed": OrderRefundFailed,
    "LotOpened": LotOpened,
    "LotSoldOut": LotSoldOut,
    "TicketCheckedIn": TicketCheckedIn,
}

EXAMPLES = sorted(path for topic in TOPICS for path in (CONTRACTS / "examples" / topic).glob("*.json"))


def test_every_consumed_topic_has_examples() -> None:
    topics = {path.parent.name for path in EXAMPLES}
    assert topics == set(TOPICS)


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda path: f"{path.parent.name}/{path.name}")
def test_contract_example_is_read(path: Path) -> None:
    raw = json.loads(path.read_text(encoding="utf-8"))
    validator(path.parent.name, raw["type"], raw["version"]).validate(raw)

    event = parse(path.read_bytes())

    if raw["type"] in contracts.DELIBERATELY_IGNORED:
        assert event is None
        return
    assert event is not None
    assert isinstance(event.payload, EXPECTED_MODEL[raw["type"]])
    assert event.event_id == raw["eventId"]
    assert event.envelope.occurred_at.tzinfo is UTC


def test_every_projected_type_has_an_example() -> None:
    types = {json.loads(path.read_text(encoding="utf-8"))["type"] for path in EXAMPLES}
    assert {event_type for event_type, _ in contracts.PAYLOADS} <= types


def _example(name: str) -> dict:
    path = next(path for path in EXAMPLES if path.name == f"{name}.v1.json")
    return json.loads(path.read_text(encoding="utf-8"))


def test_order_events_carry_the_phase_6_values() -> None:
    event = parse(json.dumps(_example("OrderConfirmed")).encode())
    assert event is not None
    assert isinstance(event.payload, OrderConfirmed)
    payload = event.payload
    assert (payload.subtotal, payload.discount_cents, payload.service_fee_cents) == (32000, 3200, 3200)
    assert (payload.service_fee_paid_by, payload.coupon_code) == ("BUYER", "LANCAMENTO10")

    refunded = parse(json.dumps(_example("OrderRefunded")).encode())
    assert refunded is not None
    assert isinstance(refunded.payload, OrderRefunded)
    assert (refunded.payload.refunded_cents, refunded.payload.reason) == (32000, "ORDER_CANCELLED")


def test_orders_published_before_phase_6_are_read_with_the_old_values() -> None:
    """O replay lê o `order.events` desde o começo: pedido antigo não tem cupom nem taxa."""
    raw = _example("OrderConfirmed")
    for field in ("subtotalCents", "discountCents", "serviceFeeCents", "serviceFeePaidBy", "couponId", "couponCode"):
        del raw["payload"][field]
    event = parse(json.dumps(raw).encode())
    assert event is not None
    assert isinstance(event.payload, OrderConfirmed)
    payload = event.payload
    assert (payload.subtotal, payload.discount_cents, payload.service_fee_cents) == (32000, 0, 0)
    assert (payload.service_fee_paid_by, payload.coupon_code) == ("BUYER", None)

    show = _example("ShowPublished")
    del show["payload"]["serviceFeePaidBy"]
    parsed = parse(json.dumps(show).encode())
    assert parsed is not None
    assert isinstance(parsed.payload, ShowSnapshot)
    assert parsed.payload.service_fee_paid_by == "BUYER"


def test_order_confirmed_items_carry_sector_lot_seat_and_price() -> None:
    event = parse(json.dumps(_example("OrderConfirmed")).encode())
    assert event is not None
    assert isinstance(event.payload, OrderConfirmed)
    item = event.payload.items[0]
    assert (item.sector_name, item.lot_name, item.seat, item.unit_price_cents) == (
        "Plateia",
        "Lote único",
        "A-5",
        16000,
    )


@pytest.mark.parametrize(
    "value",
    [b"", b"{isto nao e json", b"\xff\xfe", b"[]", b"null"],
    ids=["vazio", "json-quebrado", "nao-utf8", "lista", "null"],
)
def test_message_that_is_not_an_envelope_is_a_contract_error(value: bytes) -> None:
    with pytest.raises(ContractError):
        parse(value)


def test_message_without_value_is_a_contract_error() -> None:
    with pytest.raises(ContractError):
        parse(None)


@pytest.mark.parametrize("field", ["eventId", "type", "version", "occurredAt", "payload"])
def test_envelope_without_a_field_is_a_contract_error(field: str) -> None:
    raw = _example("OrderCreated")
    del raw[field]
    with pytest.raises(ContractError):
        parse(json.dumps(raw).encode())


def test_known_type_with_invalid_payload_is_a_contract_error() -> None:
    raw = _example("OrderConfirmed")
    raw["payload"]["items"] = []
    with pytest.raises(ContractError, match="items"):
        parse(json.dumps(raw).encode())


def test_money_must_be_an_integer() -> None:
    raw = _example("OrderConfirmed")
    raw["payload"]["items"][0]["unitPriceCents"] = 160.5
    with pytest.raises(ContractError):
        parse(json.dumps(raw).encode())


def test_unknown_type_is_ignored() -> None:
    raw = _example("OrderCreated") | {"type": "OrderRated"}
    assert parse(json.dumps(raw).encode()) is None


def test_unknown_version_of_a_known_type_is_ignored() -> None:
    # A v2 seria publicada junto com a v1 enquanto houver consumidor da antiga.
    raw = _example("OrderCreated") | {"version": 2}
    assert parse(json.dumps(raw).encode()) is None


def test_new_optional_field_does_not_break_the_reader() -> None:
    raw = _example("OrderCancelled")
    raw["payload"]["refundPolicy"] = "FULL"
    event = parse(json.dumps(raw).encode())
    assert event is not None


def test_dates_are_normalized_to_utc_with_milliseconds() -> None:
    raw = _example("OrderCreated")
    raw["payload"]["createdAt"] = "2026-11-26T15:00:00.123456-03:00"
    event = parse(json.dumps(raw).encode())
    assert event is not None
    assert isinstance(event.payload, OrderCreated)
    assert event.payload.created_at == datetime(2026, 11, 26, 18, 0, 0, 123000, tzinfo=UTC)

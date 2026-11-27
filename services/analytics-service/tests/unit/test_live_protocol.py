"""Mensagens do WebSocket do painel (`contracts/realtime-dashboard.md`) e o feed de atividade."""

import json
from datetime import UTC, datetime

import pytest

from analytics.contracts import Event, parse
from analytics.live import protocol
from analytics.live.activity import ActivityEntry, checkin_entry, decode, lot_entry, order_entry
from analytics.live.protocol import Auth, BadMessage, Subscribe, Unsubscribe
from tests import events
from tests.events import Message
from tests.scenario import at, build

SHOW_ID = "01a21a00-0000-7000-8000-000000000001"


def event(message: Message) -> Event:
    parsed = parse(message.raw())
    assert parsed is not None
    return parsed


# ------------------------------------------------------------- do cliente


def test_client_messages_are_parsed() -> None:
    assert protocol.parse('{"type": "auth", "token": "abc"}') == Auth(type="auth", token="abc")
    assert protocol.parse(json.dumps({"type": "subscribe", "showId": SHOW_ID})) == Subscribe(
        type="subscribe", show_id=SHOW_ID
    )
    assert protocol.parse(json.dumps({"type": "unsubscribe", "showId": SHOW_ID, "extra": 1})) == Unsubscribe(
        type="unsubscribe", show_id=SHOW_ID
    )


@pytest.mark.parametrize(
    ("text", "detail"),
    [
        ("{isto nao e json", "A mensagem não é JSON válido."),
        ("[1, 2]", "A mensagem deve ser um objeto JSON."),
        ('{"type": "ping"}', "Tipo de mensagem desconhecido: use auth, subscribe ou unsubscribe."),
        ('{"showId": "x"}', "Tipo de mensagem desconhecido: use auth, subscribe ou unsubscribe."),
        ('{"type": "auth"}', "Campos inválidos: token."),
        ('{"type": "auth", "token": ""}', "Campos inválidos: token."),
        ('{"type": "subscribe", "showId": "nao-e-uuid"}', "Campos inválidos: showId."),
        ('{"type": "subscribe", "showId": 42}', "Campos inválidos: showId."),
        ('{"type": "unsubscribe"}', "Campos inválidos: showId."),
        (json.dumps({"type": "auth", "token": "x" * 20_000}), "Mensagem grande demais."),
    ],
)
def test_invalid_client_messages(text: str, detail: str) -> None:
    with pytest.raises(BadMessage) as error:
        protocol.parse(text)
    assert error.value.detail == detail


# ------------------------------------------------------------ do servidor


def test_server_frames() -> None:
    assert json.loads(protocol.ready("produtor-1")) == {"type": "ready", "user": "produtor-1"}
    assert json.loads(protocol.snapshot(SHOW_ID, {"ticketsSold": 1}, [{"id": "1-0"}])) == {
        "type": "snapshot",
        "showId": SHOW_ID,
        "metrics": {"ticketsSold": 1},
        "activity": [{"id": "1-0"}],
    }
    assert json.loads(protocol.metrics(SHOW_ID, {"ticketsSold": 2})) == {
        "type": "metrics",
        "showId": SHOW_ID,
        "metrics": {"ticketsSold": 2},
    }
    assert json.loads(protocol.activity(SHOW_ID, {"id": "1-0"})) == {
        "type": "activity",
        "showId": SHOW_ID,
        "entry": {"id": "1-0"},
    }
    assert json.loads(protocol.error("forbidden", "Não.", SHOW_ID)) == {
        "type": "error",
        "code": "forbidden",
        "detail": "Não.",
        "showId": SHOW_ID,
    }
    assert "showId" not in json.loads(protocol.error("bad-request", "Não."))


def test_dates_are_utc_with_z() -> None:
    assert protocol.iso(datetime(2026, 11, 26, 18, 0, 1, tzinfo=UTC)) == "2026-11-26T18:00:01Z"
    assert protocol.iso(datetime(2026, 11, 26, 18, 0, 1, 250_000, tzinfo=UTC)) == "2026-11-26T18:00:01.250Z"


# ------------------------------------------------------------------- feed


def test_order_confirmed_entry_has_no_buyer() -> None:
    scenario = build()
    o2 = scenario.orders["o2"]
    message = o2.confirmed(at(18, 11))
    entry = order_entry(event(message), event(message).payload)  # type: ignore[arg-type]
    assert entry.show_id == scenario.show_a.id
    assert entry.body() == {
        "eventId": message.event_id,
        "type": "OrderConfirmed",
        "at": "2026-11-26T18:11:00Z",
        "orderId": o2.id,
        "sectorName": "Pista",
        "quantity": 3,
        # O total cobrado: 3 x 120,00 + a taxa de 10%, que o show A repassa ao comprador.
        "totalCents": 39600,
    }
    serialized = json.dumps(entry.body())
    assert o2.buyer_id not in serialized
    assert "buyer" not in serialized


def test_order_cancelled_entry() -> None:
    o3 = build().orders["o3"]
    message = o3.cancelled(at(18, 20, 5), "PAYMENT_DECLINED")
    entry = order_entry(event(message), event(message).payload)  # type: ignore[arg-type]
    assert entry.body() == {
        "eventId": message.event_id,
        "type": "OrderCancelled",
        "at": "2026-11-26T18:20:05Z",
        "orderId": o3.id,
        "reason": "PAYMENT_DECLINED",
        "totalCents": 26400,
    }
    assert o3.buyer_id not in json.dumps(entry.body())


def test_order_refunded_entry() -> None:
    o7 = build().orders["o7"]
    message = o7.refunded(at(19, 52))
    entry = order_entry(event(message), event(message).payload)  # type: ignore[arg-type]
    assert entry.body() == {
        "eventId": message.event_id,
        "type": "OrderRefunded",
        "at": "2026-11-26T19:52:00Z",
        "orderId": o7.id,
        # 160,00 - 10% do cupom + 16,00 de taxa: o que o comprador pagou volta inteiro.
        "refundedCents": 16000,
        "reason": "ORDER_CANCELLED",
    }
    assert o7.buyer_id not in json.dumps(entry.body())


def test_check_in_entry_has_the_sector_and_the_gate_only() -> None:
    o1 = build().orders["o1"]
    message = o1.checked_in(0, "Portão A", at(22, 1))
    entry = checkin_entry(event(message), event(message).payload)  # type: ignore[arg-type]
    assert entry.show_id == o1.show_id
    assert entry.body() == {
        "eventId": message.event_id,
        "type": "TicketCheckedIn",
        "at": "2026-11-26T22:01:00Z",
        "sectorName": "Plateia",
        "gate": "Portão A",
    }
    serialized = json.dumps(entry.body())
    assert o1.ticket_ids[0] not in serialized
    assert "A-5" not in serialized


def test_lot_entries_take_the_names_from_the_catalog() -> None:
    scenario = build()
    show = {
        "sectors": [
            {
                "id": scenario.pista.id,
                "name": "Pista",
                "lots": [{"id": scenario.lot1.id, "name": "1º lote"}, {"id": scenario.lot2.id, "name": "2º lote"}],
            }
        ]
    }
    opened = event(events.lot_opened(scenario.show_a, scenario.pista, scenario.lot2, at(19, 20)))
    assert lot_entry(opened, opened.payload, show).body() == {  # type: ignore[arg-type]
        "eventId": opened.event_id,
        "type": "LotOpened",
        "at": "2026-11-26T19:20:00Z",
        "sectorName": "Pista",
        "lotName": "2º lote",
        "priceCents": 15000,
    }
    sold_out = event(events.lot_sold_out(scenario.show_a, scenario.pista, scenario.lot1, at(19, 20)))
    assert lot_entry(sold_out, sold_out.payload, show).fields == {  # type: ignore[arg-type]
        "sectorName": "Pista",
        "lotName": "1º lote",
    }
    # Show que ainda não chegou ao analytics: os nomes ficam nulos.
    assert lot_entry(sold_out, sold_out.payload, None).fields == {  # type: ignore[arg-type]
        "sectorName": None,
        "lotName": None,
    }


def test_stream_entry_is_decoded_with_its_id() -> None:
    entry = ActivityEntry(SHOW_ID, "evento", "LotSoldOut", at(19), {"sectorName": "Pista", "lotName": "1º lote"})
    stored = {"entry": json.dumps(entry.body())}
    assert decode("1764180001000-0", stored) == {"id": "1764180001000-0", **entry.body()}

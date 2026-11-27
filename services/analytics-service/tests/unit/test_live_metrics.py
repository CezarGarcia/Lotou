"""Montagem do objeto `metrics` do painel a partir dos read models."""

from datetime import UTC, datetime

from analytics.live.metrics import assemble, current_lot

NOW = datetime(2026, 11, 26, 18, 0, 1, tzinfo=UTC)
H15 = datetime(2026, 11, 26, 15, tzinfo=UTC)
H19 = datetime(2026, 11, 26, 19, tzinfo=UTC)

PISTA = {
    "id": "pista",
    "name": "Pista",
    "capacity": 2000,
    "lots": [
        {"id": "l1", "name": "1º lote", "priceCents": 12000},
        {"id": "l2", "name": "2º lote", "priceCents": 15000},
    ],
}
PLATEIA = {"id": "plateia", "name": "Plateia", "capacity": 80, "lots": [{"id": "lu", "name": "Lote único"}]}
SHOW = {"_id": "show", "sectors": [PISTA, PLATEIA]}


def opened(at: datetime, price: int = 12000) -> dict:
    return {"type": "OPENED", "at": at, "priceCents": price}


def sold_out(at: datetime) -> dict:
    return {"type": "SOLD_OUT", "at": at}


def lot(sector: str, lot_id: str, *transitions: dict) -> dict:
    return {"sectorId": sector, "lotId": lot_id, "transitions": list(transitions)}


def test_metrics_of_a_show_on_sale() -> None:
    metrics = assemble(
        SHOW,
        {"confirmedOrders": 3, "cancelledOrders": 2, "refundedOrders": 1},
        [
            {"_id": "pista", "ticketsSold": 7, "revenueCents": 96000},
            {"_id": "plateia", "ticketsSold": 80, "revenueCents": 1_280_000},
            # Setor que saiu do catálogo: entra nos totais, não na lista.
            {"_id": "antigo", "ticketsSold": 1, "revenueCents": 5000},
        ],
        [lot("pista", "l1", opened(H15), sold_out(H19)), lot("pista", "l2", opened(H19, 15000))],
        orders_last_minute=2,
        now=NOW,
        checkin_docs=[
            {"gate": "Portão B", "checkedIn": 4},
            {"gate": "Portão A", "checkedIn": 7},
        ],
    )
    assert metrics == {
        "at": "2026-11-26T18:00:01Z",
        "ticketsSold": 88,
        "revenueCents": 1_381_000,
        "ordersConfirmed": 3,
        "ordersCancelled": 2,
        "ordersRefunded": 1,
        "ordersLastMinute": 2,
        "checkedIn": 11,
        # Em ordem alfabética do portão.
        "checkinsByGate": [{"gate": "Portão A", "count": 7}, {"gate": "Portão B", "count": 4}],
        "sectors": [
            {
                "sectorId": "pista",
                "name": "Pista",
                "capacity": 2000,
                "sold": 7,
                "remaining": 1993,
                "currentLot": {"lotId": "l2", "name": "2º lote", "priceCents": 15000, "status": "ON_SALE"},
            },
            {
                "sectorId": "plateia",
                "name": "Plateia",
                "capacity": 80,
                "sold": 80,
                "remaining": 0,
                "currentLot": None,
            },
        ],
    }


def test_before_any_sale_everything_is_zero() -> None:
    metrics = assemble(SHOW, None, [], [], orders_last_minute=0, now=NOW)
    assert (metrics["ticketsSold"], metrics["revenueCents"], metrics["ordersConfirmed"]) == (0, 0, 0)
    assert (metrics["ordersRefunded"], metrics["checkedIn"], metrics["checkinsByGate"]) == (0, 0, [])
    assert [(s["sold"], s["remaining"], s["currentLot"]) for s in metrics["sectors"]] == [
        (0, 2000, None),
        (0, 80, None),
    ]


def test_remaining_never_goes_below_zero() -> None:
    metrics = assemble(SHOW, None, [{"_id": "plateia", "ticketsSold": 82, "revenueCents": 0}], [], 0, NOW)
    assert metrics["sectors"][1]["remaining"] == 0


def test_current_lot_follows_the_lot_timeline() -> None:
    # Antes da abertura: nada.
    assert current_lot(PISTA, {}) is None
    # O lote à venda ganha do esgotado, mesmo que o esgotamento seja mais recente.
    assert current_lot(PISTA, {"l1": [opened(H15)], "l2": [opened(H15), sold_out(H19)]}) == {
        "lotId": "l1",
        "name": "1º lote",
        "priceCents": 12000,
        "status": "ON_SALE",
    }
    # Tudo esgotado: o último que esgotou.
    assert current_lot(PISTA, {"l1": [opened(H15), sold_out(H15)], "l2": [opened(H15), sold_out(H19)]}) == {
        "lotId": "l2",
        "name": "2º lote",
        "priceCents": 15000,
        "status": "SOLD_OUT",
    }
    # Lote que não está no catálogo: o preço vem da abertura.
    assert current_lot(PISTA, {"lx": [opened(H15, 9900)]}) == {
        "lotId": "lx",
        "name": None,
        "priceCents": 9900,
        "status": "ON_SALE",
    }

"""Montagem das respostas: ocupação, séries horárias e linha do tempo dos lotes."""

from datetime import UTC, datetime

from analytics.api import views

H18 = datetime(2026, 11, 26, 18, tzinfo=UTC)
H19 = datetime(2026, 11, 26, 19, tzinfo=UTC)

SHOW = {
    "_id": "show",
    "title": "Vinte Anos de Estrada",
    "status": "ON_SALE",
    "venue": {"timezone": "America/Sao_Paulo"},
    "sectors": [
        {
            "id": "pista",
            "name": "Pista",
            "kind": "GENERAL_ADMISSION",
            "capacity": 2000,
            "lots": [
                {"id": "l1", "name": "1º lote", "priceCents": 12000, "quantity": 1000},
                {"id": "l2", "name": "2º lote", "priceCents": 15000, "quantity": 1000},
            ],
        },
        {
            "id": "plateia",
            "name": "Plateia",
            "kind": "RESERVED_SEATING",
            "capacity": 80,
            "lots": [{"id": "lu", "name": "Lote único", "priceCents": 16000, "quantity": 80}],
        },
    ],
}


def bucket(sector: str, hour: datetime, lots: dict[str, tuple[int, int]], orders: int) -> dict:
    return {
        "sectorId": sector,
        "hour": hour,
        "ticketsSold": sum(tickets for tickets, _ in lots.values()),
        "revenueCents": sum(revenue for _, revenue in lots.values()),
        "orders": orders,
        "lots": {lot: {"ticketsSold": t, "revenueCents": r} for lot, (t, r) in lots.items()},
    }


def test_occupancy() -> None:
    assert views.occupancy(2, 80) == 0.025
    assert views.occupancy(7, 2000) == 0.0035
    assert views.occupancy(1, 3) == 0.3333
    assert views.occupancy(5, None) is None
    assert views.occupancy(0, 0) is None


def test_sales_by_sector_with_hourly_series_and_lots() -> None:
    hourly = [
        bucket("pista", H18, {"l1": (3, 36000)}, 1),
        bucket("plateia", H18, {"lu": (2, 32000)}, 1),
        bucket("pista", H19, {"l2": (4, 60000)}, 1),
    ]
    lots = [
        {
            "sectorId": "pista",
            "lotId": "l1",
            "transitions": [
                {"type": "OPENED", "at": datetime(2026, 11, 26, 15, tzinfo=UTC), "priceCents": 12000, "available": 5},
                {"type": "SOLD_OUT", "at": datetime(2026, 11, 26, 19, 20, tzinfo=UTC)},
            ],
        },
        {
            "sectorId": "pista",
            "lotId": "l2",
            "transitions": [{"type": "OPENED", "at": datetime(2026, 11, 26, 19, 20, tzinfo=UTC)}],
        },
    ]

    result = views.sales(SHOW, hourly, lots)

    assert result.totals.tickets_sold == 9
    assert result.totals.capacity == 2080
    assert result.totals.revenue_cents == 128000
    assert result.totals.orders == 3
    assert [(h.hour, h.tickets_sold, h.revenue_cents, h.orders) for h in result.hourly] == [
        (H18, 5, 68000, 2),
        (H19, 4, 60000, 1),
    ]
    pista, plateia = result.sectors
    assert (pista.name, pista.tickets_sold, pista.occupancy, pista.revenue_cents) == ("Pista", 7, 0.0035, 96000)
    assert (plateia.name, plateia.tickets_sold, plateia.occupancy) == ("Plateia", 2, 0.025)
    l1, l2 = pista.lots
    assert (l1.name, l1.tickets_sold, l1.revenue_cents, l1.status) == ("1º lote", 3, 36000, "SOLD_OUT")
    assert l1.opened_at == datetime(2026, 11, 26, 15, tzinfo=UTC)
    assert l1.sold_out_at == datetime(2026, 11, 26, 19, 20, tzinfo=UTC)
    assert (l2.tickets_sold, l2.status, l2.sold_out_at) == (4, "ON_SALE", None)
    assert plateia.lots[0].status is None  # sem fato do inventory sobre o lote


def test_sector_with_sales_but_missing_from_the_catalog_still_shows_up() -> None:
    result = views.sales(SHOW, [bucket("removido", H18, {"lx": (1, 100)}, 1)], [])
    removed = result.sectors[-1]
    assert (removed.sector_id, removed.name, removed.capacity, removed.occupancy) == ("removido", None, None, None)
    assert removed.lots[0].lot_id == "lx"
    assert result.totals.tickets_sold == 1


def test_statement_of_a_show_without_sales_is_zeroed() -> None:
    show = SHOW | {
        "producerId": "p",
        "artist": "Os Tropicais do Asfalto",
        "startsAt": H19,
        "venue": {"name": "Teatro Guanabara", "city": "Rio de Janeiro", "timezone": "America/Sao_Paulo"},
    }
    result = views.statement(show, None)
    assert result.gross_sales_cents == 0
    assert result.receivable_cents == 0
    assert result.partial is True


def test_internal_statement_carries_the_show_for_the_pdf() -> None:
    show = SHOW | {
        "producerId": "produtor",
        "artist": "Os Tropicais do Asfalto",
        "startsAt": datetime(2026, 12, 16, 23, 30, tzinfo=UTC),
        "venue": {"name": "Teatro Guanabara", "city": "Rio de Janeiro", "timezone": "America/Sao_Paulo"},
        "status": "FINISHED",
    }
    body = views.internal_statement(show, None).model_dump(mode="json", by_alias=True)
    assert body["producerId"] == "produtor"
    assert (body["artist"], body["venueName"], body["timezone"]) == (
        "Os Tropicais do Asfalto",
        "Teatro Guanabara",
        "America/Sao_Paulo",
    )
    assert body["startsAt"] == "2026-12-16T23:30:00Z"
    # Sem venda nenhuma, sai zerado; o show terminou, então o relatório é final.
    assert (body["receivableCents"], body["buyerFeesCents"], body["refundedOrders"]) == (0, 0, 0)
    assert body["partial"] is False

"""Monta as respostas a partir dos documentos dos read models.

A ocupação (vendidos / capacidade) é calculada na leitura, com a capacidade do
catálogo: assim ela fica certa mesmo quando a venda chegou antes do show, ou
quando o produtor muda a capacidade de um setor.
"""

from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import datetime
from typing import Any

from analytics.api import schemas
from analytics.domain import statement as domain

Doc = Mapping[str, Any]


def occupancy(sold: int, capacity: int | None) -> float | None:
    if not capacity:
        return None
    return round(sold / capacity, 4)


def sales(show: Doc, hourly_docs: Iterable[Doc], lot_docs: Iterable[Doc]) -> schemas.ShowSales:
    by_sector: dict[str, list[Doc]] = defaultdict(list)
    for doc in hourly_docs:
        by_sector[doc["sectorId"]].append(doc)
    timelines: dict[str, dict[str, list[Doc]]] = defaultdict(dict)
    for doc in lot_docs:
        timelines[doc["sectorId"]][doc["lotId"]] = doc["transitions"]

    catalog_sectors = {sector["id"]: sector for sector in show["sectors"]}
    # Setores do catálogo na ordem dele; depois, algum que tenha venda e já não esteja nele.
    sector_ids = list(catalog_sectors) + sorted(set(by_sector) - set(catalog_sectors))

    sectors = [
        _sector(sector_id, catalog_sectors.get(sector_id), by_sector[sector_id], timelines[sector_id])
        for sector_id in sector_ids
    ]
    sold = sum(sector.tickets_sold for sector in sectors)
    capacity = sum(sector.capacity or 0 for sector in sectors)
    return schemas.ShowSales(
        show_id=show["_id"],
        title=show["title"],
        status=show["status"],
        timezone=show["venue"]["timezone"],
        totals=schemas.SalesTotals(
            tickets_sold=sold,
            capacity=capacity,
            occupancy=occupancy(sold, capacity),
            revenue_cents=sum(sector.revenue_cents for sector in sectors),
            # Uma reserva é de um setor só, então somar os setores não conta um pedido duas vezes.
            orders=sum(sector.orders for sector in sectors),
        ),
        sectors=sectors,
        hourly=_merge_hours(sector.hourly for sector in sectors),
    )


def _sector(
    sector_id: str, catalog: Doc | None, docs: list[Doc], timelines: Mapping[str, list[Doc]]
) -> schemas.SectorSales:
    hourly = sorted(
        (
            schemas.HourlySales(
                hour=doc["hour"],
                tickets_sold=doc["ticketsSold"],
                revenue_cents=doc["revenueCents"],
                orders=doc["orders"],
            )
            for doc in docs
        ),
        key=lambda bucket: bucket.hour,
    )
    lot_totals: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for doc in docs:
        for lot_id, totals in (doc.get("lots") or {}).items():
            lot_totals[lot_id][0] += totals.get("ticketsSold", 0)
            lot_totals[lot_id][1] += totals.get("revenueCents", 0)

    catalog_lots = {lot["id"]: lot for lot in catalog["lots"]} if catalog else {}
    lot_ids = list(catalog_lots) + sorted((set(lot_totals) | set(timelines)) - set(catalog_lots))
    lots = [
        _lot(lot_id, catalog_lots.get(lot_id), lot_totals.get(lot_id, [0, 0]), timelines.get(lot_id, []))
        for lot_id in lot_ids
    ]

    sold = sum(bucket.tickets_sold for bucket in hourly)
    capacity = catalog["capacity"] if catalog else None
    return schemas.SectorSales(
        sector_id=sector_id,
        name=catalog["name"] if catalog else None,
        kind=catalog["kind"] if catalog else None,
        capacity=capacity,
        tickets_sold=sold,
        occupancy=occupancy(sold, capacity),
        revenue_cents=sum(bucket.revenue_cents for bucket in hourly),
        orders=sum(bucket.orders for bucket in hourly),
        lots=lots,
        hourly=hourly,
    )


def _lot(lot_id: str, catalog: Doc | None, totals: list[int], transitions: list[Doc]) -> schemas.LotSales:
    timeline = [
        schemas.LotTransition(
            type=entry["type"], at=entry["at"], price_cents=entry.get("priceCents"), available=entry.get("available")
        )
        for entry in transitions
    ]
    opened = [entry.at for entry in timeline if entry.type == "OPENED"]
    sold_out = [entry.at for entry in timeline if entry.type == "SOLD_OUT"]
    status: Any = None
    if timeline:
        status = "ON_SALE" if timeline[-1].type == "OPENED" else "SOLD_OUT"
    return schemas.LotSales(
        lot_id=lot_id,
        name=catalog["name"] if catalog else None,
        price_cents=catalog["priceCents"] if catalog else None,
        quantity=catalog["quantity"] if catalog else None,
        tickets_sold=totals[0],
        revenue_cents=totals[1],
        status=status,
        opened_at=opened[0] if opened else None,
        sold_out_at=sold_out[-1] if sold_out else None,
        timeline=timeline,
    )


def _merge_hours(series: Iterable[list[schemas.HourlySales]]) -> list[schemas.HourlySales]:
    merged: dict[datetime, list[int]] = defaultdict(lambda: [0, 0, 0])
    for buckets in series:
        for bucket in buckets:
            totals = merged[bucket.hour]
            totals[0] += bucket.tickets_sold
            totals[1] += bucket.revenue_cents
            totals[2] += bucket.orders
    return [
        schemas.HourlySales(hour=hour, tickets_sold=sold, revenue_cents=revenue, orders=orders)
        for hour, (sold, revenue, orders) in sorted(merged.items())
    ]


def _statement_fields(show: Doc, doc: Doc | None) -> dict[str, Any]:
    current = domain.new(show["_id"]) | dict(doc or {})
    # O status do show vem do catálogo: o relatório fica final quando o show termina.
    domain.attach_show(current, show)
    return {
        "show_id": show["_id"],
        "title": show["title"],
        "status": show["status"],
        "partial": current["partial"],
        "currency": current["currency"],
        "gross_sales_cents": current["grossSalesCents"],
        "discounts_cents": current["discountsCents"],
        "refunds_cents": current["refundsCents"],
        "platform_fee_cents": current["platformFeeCents"],
        "buyer_fees_cents": current["buyerFeesCents"],
        "receivable_cents": current["receivableCents"],
        "orders_created": current["ordersCreated"],
        "confirmed_orders": current["confirmedOrders"],
        "cancelled_orders": current["cancelledOrders"],
        "cancelled_by_reason": current["cancelledByReason"],
        "refunded_orders": current["refundedOrders"],
        "tickets_sold": current["ticketsSold"],
        "tickets_refunded": current["ticketsRefunded"],
        "tickets_issued": current["ticketsIssued"],
        "last_event_at": current["lastEventAt"],
    }


def statement(show: Doc, doc: Doc | None) -> schemas.Statement:
    """Relatório do show. Sem venda nenhuma ainda, sai zerado (e parcial)."""
    return schemas.Statement(**_statement_fields(show, doc))


def internal_statement(show: Doc, doc: Doc | None) -> schemas.InternalStatement:
    """O relatório com o dono e os dados do show, para o PDF do notification-service."""
    return schemas.InternalStatement(
        **_statement_fields(show, doc),
        producer_id=show["producerId"],
        artist=show["artist"],
        starts_at=show["startsAt"],
        timezone=show["venue"]["timezone"],
        venue_name=show["venue"]["name"],
    )


def order(doc: Doc) -> schemas.Order:
    show = doc.get("show")
    return schemas.Order(
        order_id=doc["_id"],
        show_id=doc["showId"],
        status=doc["status"],
        total_cents=doc["totalCents"],
        subtotal_cents=doc.get("subtotalCents"),
        discount_cents=doc.get("discountCents"),
        service_fee_cents=doc.get("serviceFeeCents"),
        service_fee_paid_by=doc.get("serviceFeePaidBy"),
        coupon_code=doc.get("couponCode"),
        items=[schemas.OrderItem.model_validate(item) for item in doc["items"]],
        tickets=[schemas.Ticket.model_validate({"status": "VALID"} | ticket) for ticket in doc["tickets"]],
        created_at=doc["createdAt"],
        confirmed_at=doc["confirmedAt"],
        cancelled_at=doc["cancelledAt"],
        cancel_reason=doc["cancelReason"],
        tickets_issued_at=doc["ticketsIssuedAt"],
        tickets_cancelled_at=doc.get("ticketsCancelledAt"),
        refund_reason=doc.get("refundReason"),
        refunded_at=doc.get("refundedAt"),
        refunded_cents=doc.get("refundedCents"),
        refund_failed_at=doc.get("refundFailedAt"),
        refund_attempts=doc.get("refundAttempts"),
        timeline=[
            schemas.TimelineEntry(status=entry["status"], at=entry["at"], reason=entry.get("reason"))
            for entry in doc["timeline"]
        ],
        show=schemas.ShowSummary.model_validate(show) if show else None,
    )


def producer_show(show: Doc, statement: Doc | None) -> schemas.ProducerShow:
    """Item da lista de shows do produtor. Sem venda ainda, vendidos e receita saem zerados."""
    return schemas.ProducerShow(
        show_id=show["_id"],
        title=show["title"],
        artist=show["artist"],
        starts_at=show["startsAt"],
        timezone=show["venue"]["timezone"],
        venue_name=show["venue"]["name"],
        city=show["venue"]["city"],
        status=show["status"],
        tickets_sold=domain.net_tickets(statement) if statement else 0,
        revenue_cents=domain.net_revenue_cents(statement) if statement else 0,
    )

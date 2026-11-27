"""O objeto `metrics` do painel, a partir dos read models da geração ativa.

- Totais e setores vêm do `sales_by_sector` (somado por setor no MongoDB), com
  a capacidade e os nomes da cópia do catálogo. `remaining` é capacidade menos
  vendidos: reservas seguradas não contam, porque o analytics só vê o pedido
  confirmado.
- Pedidos confirmados e cancelados vêm do relatório (`producer_statements`).
- `ordersLastMinute` conta os pedidos com `confirmedAt` no último minuto do
  relógio, pelo índice (showId, confirmedAt) do `order_view`.
- `currentLot` vem da linha do tempo dos lotes: o lote à venda aberto por
  último; se nenhum está à venda, o último que esgotou; `null` antes da abertura.

Setores que têm venda mas saíram do catálogo entram nos totais, não na lista
(sem nome nem capacidade não há o que mostrar no painel).
"""

import asyncio
from collections import defaultdict
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from typing import Any

from analytics.live.protocol import iso
from analytics.store.read_models import ReadModels

Doc = Mapping[str, Any]

LAST_MINUTE = timedelta(minutes=1)


def assemble(
    show: Doc,
    statement: Doc | None,
    sales_by_sector: Iterable[Doc],
    lot_docs: Iterable[Doc],
    orders_last_minute: int,
    now: datetime,
) -> dict[str, Any]:
    """`sales_by_sector`: um documento por setor, `{_id: sectorId, ticketsSold, revenueCents}`."""
    sold_by_sector = {doc["_id"]: doc for doc in sales_by_sector}
    timelines: dict[str, dict[str, list[Doc]]] = defaultdict(dict)
    for doc in lot_docs:
        timelines[doc["sectorId"]][doc["lotId"]] = doc.get("transitions") or []

    sectors = []
    for sector in show["sectors"]:
        sold = int(sold_by_sector.get(sector["id"], {}).get("ticketsSold", 0))
        sectors.append(
            {
                "sectorId": sector["id"],
                "name": sector["name"],
                "capacity": sector["capacity"],
                "sold": sold,
                "remaining": max(sector["capacity"] - sold, 0),
                "currentLot": current_lot(sector, timelines.get(sector["id"], {})),
            }
        )
    return {
        "at": iso(now),
        "ticketsSold": sum(int(doc.get("ticketsSold", 0)) for doc in sold_by_sector.values()),
        "revenueCents": sum(int(doc.get("revenueCents", 0)) for doc in sold_by_sector.values()),
        "ordersConfirmed": int(statement["confirmedOrders"]) if statement else 0,
        "ordersCancelled": int(statement["cancelledOrders"]) if statement else 0,
        "ordersLastMinute": orders_last_minute,
        "sectors": sectors,
    }


def current_lot(sector: Doc, timelines: Mapping[str, list[Doc]]) -> dict[str, Any] | None:
    """O lote que o painel mostra no setor, com o status do último fato do inventory."""
    candidates: list[tuple[bool, datetime, str, Doc]] = []
    for lot_id, transitions in timelines.items():
        if not transitions:
            continue
        last = transitions[-1]
        candidates.append((last["type"] == "OPENED", last["at"], lot_id, last))
    if not candidates:
        return None
    # À venda antes de esgotado; entre iguais, o fato mais recente.
    on_sale, _, lot_id, last = max(candidates, key=lambda c: (c[0], c[1], c[2]))
    catalog = next((lot for lot in sector.get("lots", []) if lot["id"] == lot_id), None)
    opened = [t for t in timelines[lot_id] if t["type"] == "OPENED"]
    price = catalog["priceCents"] if catalog else (opened[-1].get("priceCents") if opened else None)
    return {
        "lotId": lot_id,
        "name": catalog["name"] if catalog else None,
        "priceCents": int(price) if price is not None else None,
        "status": "ON_SALE" if on_sale else "SOLD_OUT",
    }


async def compute(models: ReadModels, show_id: str, now: datetime) -> dict[str, Any] | None:
    """As métricas do show agora; `None` se o show não está no catálogo."""
    show = await models.shows.find_one({"_id": show_id}, projection={"sectors": 1})
    if show is None:
        return None
    statement, sales, lots, last_minute = await asyncio.gather(
        models.statements.find_one({"_id": show_id}, projection={"confirmedOrders": 1, "cancelledOrders": 1}),
        _sales_by_sector(models, show_id),
        models.lots.find({"showId": show_id}, projection={"sectorId": 1, "lotId": 1, "transitions": 1}).to_list(None),
        models.orders.count_documents({"showId": show_id, "confirmedAt": {"$gte": now - LAST_MINUTE}}),
    )
    return assemble(show, statement, sales, lots, last_minute, now)


async def _sales_by_sector(models: ReadModels, show_id: str) -> list[dict[str, Any]]:
    cursor = await models.sales.aggregate(
        [
            {"$match": {"showId": show_id}},
            {
                "$group": {
                    "_id": "$sectorId",
                    "ticketsSold": {"$sum": "$ticketsSold"},
                    "revenueCents": {"$sum": "$revenueCents"},
                }
            },
        ]
    )
    return await cursor.to_list(None)

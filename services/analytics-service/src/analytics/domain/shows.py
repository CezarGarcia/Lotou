"""Cópia do catálogo que o analytics precisa: nomes, dono, fuso, setores e lotes."""

from collections.abc import Mapping
from typing import Any

from bson.int64 import Int64

from analytics.contracts import ShowSnapshot


def to_doc(show: ShowSnapshot) -> dict[str, Any]:
    """Documento da coleção `shows`. As fileiras do mapa ficam de fora: não servem aqui."""
    return {
        "_id": show.show_id,
        "showId": show.show_id,
        "version": show.version,
        "producerId": show.producer_id,
        "status": show.status,
        "title": show.title,
        "artist": show.artist,
        "startsAt": show.starts_at,
        "doorsOpenAt": show.doors_open_at,
        "salesStartAt": show.sales_start_at,
        "salesEndAt": show.sales_end_at,
        "highDemand": show.high_demand,
        "venue": {
            "id": show.venue.id,
            "name": show.venue.name,
            "city": show.venue.city,
            "state": show.venue.state,
            "timezone": show.venue.timezone,
        },
        "sectors": [
            {
                "id": sector.id,
                "name": sector.name,
                "kind": sector.kind,
                "capacity": sector.capacity,
                "lots": [
                    {
                        "id": lot.id,
                        "name": lot.name,
                        "priceCents": Int64(lot.price_cents),
                        "quantity": lot.quantity,
                        "opensAt": lot.opens_at,
                    }
                    for lot in sector.lots
                ],
            }
            for sector in show.sectors
        ],
        "updatedAt": show.updated_at,
        "serviceFeePaidBy": show.service_fee_paid_by,
    }


def summary(show: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """O que vai copiado para dentro do `order_view` (título, artista, data e local)."""
    if show is None:
        return None
    return {
        "title": show["title"],
        "artist": show["artist"],
        "startsAt": show["startsAt"],
        "venueName": show["venue"]["name"],
        "city": show["venue"]["city"],
        "timezone": show["venue"]["timezone"],
    }

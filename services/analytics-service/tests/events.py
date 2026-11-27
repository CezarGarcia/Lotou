"""Mensagens de teste no formato de `contracts/`, conferidas contra os JSON Schemas.

Toda mensagem montada aqui passa pelo schema do seu tipo antes de ser usada,
então os testes nunca exercitam um formato que o produtor não publicaria.
"""

import base64
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"

TOPIC_BY_TYPE = {
    "ShowPublished": "shows.catalog",
    "ShowUpdated": "shows.catalog",
    "OrderCreated": "order.events",
    "OrderConfirmed": "order.events",
    "OrderCancelled": "order.events",
    "TicketsIssued": "order.events",
    "TicketsCancelled": "order.events",
    "OrderRefunded": "order.events",
    "OrderRefundFailed": "order.events",
    "LotOpened": "inventory.events",
    "LotSoldOut": "inventory.events",
    "ReservationConfirmed": "inventory.events",
    "ReservationReleased": "inventory.events",
    "ReservationReturned": "inventory.events",
    "TicketCheckedIn": "checkin.events",
    "CheckinRejected": "checkin.events",
}


def uuid7(at: datetime | None = None) -> str:
    """UUID v7 (o Python 3.13 ainda não tem `uuid.uuid7`)."""
    ms = int(at.timestamp() * 1000) if at else time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10))
    value = (ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= (rand >> 68 & 0xFFF) << 64
    value |= 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


def iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat().replace("+00:00", "Z")


@cache
def validator(topic: str, event_type: str, version: int = 1) -> Draft202012Validator:
    schema = json.loads((CONTRACTS / topic / f"{event_type}.v{version}.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema, format_checker=FormatChecker())


@dataclass(frozen=True)
class Message:
    topic: str
    key: str
    value: dict[str, Any]
    headers: list[tuple[str, bytes]] = field(default_factory=list)

    @property
    def event_id(self) -> str:
        return str(self.value["eventId"])

    @property
    def type(self) -> str:
        return str(self.value["type"])

    def raw(self) -> bytes:
        return json.dumps(self.value).encode()


def envelope(event_type: str, key: str, payload: dict[str, Any], at: datetime) -> Message:
    value = {"eventId": uuid7(at), "type": event_type, "version": 1, "occurredAt": iso(at), "payload": payload}
    topic = TOPIC_BY_TYPE[event_type]
    validator(topic, event_type).validate(value)
    traceparent = f"00-{os.urandom(16).hex()}-{os.urandom(8).hex()}-01".encode()
    return Message(topic=topic, key=key, value=value, headers=[("traceparent", traceparent)])


# --------------------------------------------------------------- catálogo


@dataclass(frozen=True)
class LotSpec:
    id: str
    name: str
    price_cents: int
    quantity: int


@dataclass(frozen=True)
class SectorSpec:
    id: str
    name: str
    kind: str
    capacity: int
    lots: tuple[LotSpec, ...]


@dataclass(frozen=True)
class ShowSpec:
    id: str
    producer_id: str
    title: str
    artist: str
    starts_at: datetime
    sectors: tuple[SectorSpec, ...]
    timezone: str = "America/Sao_Paulo"
    service_fee_paid_by: str = "BUYER"


def show_event(
    show: ShowSpec,
    *,
    version: int,
    status: str,
    at: datetime,
    event_type: str = "ShowUpdated",
    title: str | None = None,
) -> Message:
    payload = {
        "showId": show.id,
        "version": version,
        "producerId": show.producer_id,
        "status": status,
        "title": title or show.title,
        "artist": show.artist,
        "startsAt": iso(show.starts_at),
        "doorsOpenAt": iso(show.starts_at - timedelta(hours=1)),
        "salesStartAt": None,
        "salesEndAt": None,
        "highDemand": False,
        "venue": {
            "id": str(uuid.uuid5(uuid.NAMESPACE_URL, show.id)),
            "name": "Teatro Guanabara",
            "city": "Rio de Janeiro",
            "state": "RJ",
            "timezone": show.timezone,
        },
        "sectors": [
            {
                "id": sector.id,
                "name": sector.name,
                "kind": sector.kind,
                "capacity": sector.capacity,
                "rows": [{"label": "A", "seatCount": sector.capacity}] if sector.kind == "RESERVED_SEATING" else [],
                "lots": [
                    {
                        "id": lot.id,
                        "name": lot.name,
                        "priceCents": lot.price_cents,
                        "quantity": lot.quantity,
                        "opensAt": None,
                    }
                    for lot in sector.lots
                ],
            }
            for sector in show.sectors
        ],
        "updatedAt": iso(at),
        "serviceFeePaidBy": show.service_fee_paid_by,
    }
    return envelope(event_type, show.id, payload, at)


# ----------------------------------------------------------------- pedido


def service_fee(price_cents: int) -> int:
    """10% do ingresso, antes do desconto, arredondado para o centavo mais próximo."""
    return (price_cents + 5) // 10


@dataclass(frozen=True)
class Coupon:
    code: str
    percent: int | None = None
    amount_cents: int | None = None

    def discount(self, subtotal: int) -> int:
        """Só sobre os ingressos, arredondado para baixo, nunca abaixo de zero."""
        if self.percent is not None:
            return subtotal * self.percent // 100
        return min(self.amount_cents or 0, subtotal)


@dataclass(frozen=True)
class OrderSpec:
    id: str
    show_id: str
    buyer_id: str
    reservation_id: str
    sector: SectorSpec
    lot: LotSpec
    seats: tuple[str | None, ...]
    fee_paid_by: str = "BUYER"
    coupon: Coupon | None = None

    @property
    def subtotal_cents(self) -> int:
        return self.lot.price_cents * len(self.seats)

    @property
    def discount_cents(self) -> int:
        return self.coupon.discount(self.subtotal_cents) if self.coupon else 0

    @property
    def fee_cents(self) -> int:
        return service_fee(self.lot.price_cents) * len(self.seats)

    @property
    def total_cents(self) -> int:
        """O que o comprador paga: subtotal − desconto + taxa (se o comprador paga a taxa)."""
        fee = self.fee_cents if self.fee_paid_by == "BUYER" else 0
        return self.subtotal_cents - self.discount_cents + fee

    @property
    def ticket_ids(self) -> list[str]:
        # Determinísticos: as entradas na portaria e o cancelamento citam os mesmos ingressos.
        return [str(uuid.uuid5(uuid.NAMESPACE_URL, f"{self.id}/{index}")) for index in range(len(self.seats))]

    def items(self) -> list[dict[str, Any]]:
        return [
            {
                "sectorId": self.sector.id,
                "sectorName": self.sector.name,
                "lotId": self.lot.id,
                "lotName": self.lot.name,
                "seat": seat,
                "unitPriceCents": self.lot.price_cents,
            }
            for seat in self.seats
        ]

    def _pricing(self) -> dict[str, Any]:
        return {
            "subtotalCents": self.subtotal_cents,
            "discountCents": self.discount_cents,
            "serviceFeeCents": self.fee_cents,
            "serviceFeePaidBy": self.fee_paid_by,
            "couponId": str(uuid.uuid5(uuid.NAMESPACE_URL, self.coupon.code)) if self.coupon else None,
            "couponCode": self.coupon.code if self.coupon else None,
        }

    def _base(self) -> dict[str, Any]:
        return {
            "orderId": self.id,
            "buyerId": self.buyer_id,
            "showId": self.show_id,
            "reservationId": self.reservation_id,
            "totalCents": self.total_cents,
        }

    def created(self, at: datetime) -> Message:
        payload = {**self._base(), "items": self.items(), "createdAt": iso(at), **self._pricing()}
        return envelope("OrderCreated", self.id, payload, at)

    def confirmed(self, at: datetime) -> Message:
        payload = {**self._base(), "items": self.items(), "confirmedAt": iso(at), **self._pricing()}
        return envelope("OrderConfirmed", self.id, payload, at)

    def cancelled(self, at: datetime, reason: str) -> Message:
        return envelope("OrderCancelled", self.id, {**self._base(), "reason": reason, "cancelledAt": iso(at)}, at)

    def tickets_issued(self, at: datetime) -> Message:
        tickets = []
        for ticket_id, seat in zip(self.ticket_ids, self.seats, strict=True):
            tickets.append(
                {
                    "ticketId": ticket_id,
                    "sectorId": self.sector.id,
                    "sectorName": self.sector.name,
                    "seat": seat,
                    # O analytics ignora o código do QR (é a credencial de entrada); só o formato importa aqui.
                    "code": f"LOTOU1.{ticket_id}.{base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip('=')}",
                }
            )
        payload = {
            "orderId": self.id,
            "buyerId": self.buyer_id,
            "showId": self.show_id,
            "tickets": tickets,
            "issuedAt": iso(at),
        }
        return envelope("TicketsIssued", self.id, payload, at)

    def tickets_cancelled(self, at: datetime, reason: str = "ORDER_CANCELLED") -> Message:
        payload = {
            "orderId": self.id,
            "buyerId": self.buyer_id,
            "showId": self.show_id,
            "ticketIds": self.ticket_ids,
            "reason": reason,
            "cancelledAt": iso(at),
        }
        return envelope("TicketsCancelled", self.id, payload, at)

    def refund_failed(self, at: datetime, attempts: int = 5) -> Message:
        payload = {
            "orderId": self.id,
            "buyerId": self.buyer_id,
            "showId": self.show_id,
            "attempts": attempts,
            "failedAt": iso(at),
        }
        return envelope("OrderRefundFailed", self.id, payload, at)

    def refunded(self, at: datetime, reason: str = "ORDER_CANCELLED") -> Message:
        base = {key: value for key, value in self._base().items() if key != "totalCents"}
        payload = {
            **base,
            "refundedCents": self.total_cents,
            "reason": reason,
            "refundedAt": iso(at),
            **self._pricing(),
        }
        return envelope("OrderRefunded", self.id, payload, at)

    def checked_in(self, index: int, gate: str, at: datetime) -> Message:
        payload = {
            "ticketId": self.ticket_ids[index],
            "showId": self.show_id,
            "orderId": self.id,
            "sectorId": self.sector.id,
            "sectorName": self.sector.name,
            "seat": self.seats[index],
            "gate": gate,
            "checkedInAt": iso(at),
        }
        # Chave do checkin.events: o show.
        return envelope("TicketCheckedIn", self.show_id, payload, at)


def order(
    show: ShowSpec,
    sector: SectorSpec,
    lot: LotSpec,
    seats: tuple[str | None, ...],
    at: datetime,
    *,
    coupon: Coupon | None = None,
) -> OrderSpec:
    return OrderSpec(
        id=uuid7(at),
        show_id=show.id,
        buyer_id=str(uuid.uuid4()),
        reservation_id=uuid7(at),
        sector=sector,
        lot=lot,
        seats=seats,
        fee_paid_by=show.service_fee_paid_by,
        coupon=coupon,
    )


def checkin_rejected(show: ShowSpec, gate: str, at: datetime) -> Message:
    payload = {"showId": show.id, "gate": gate, "reason": "INVALID_CODE", "ticketId": None, "rejectedAt": iso(at)}
    return envelope("CheckinRejected", show.id, payload, at)


# -------------------------------------------------------------- inventory


def lot_opened(show: ShowSpec, sector: SectorSpec, lot: LotSpec, at: datetime) -> Message:
    payload = {
        "showId": show.id,
        "sectorId": sector.id,
        "lotId": lot.id,
        "priceCents": lot.price_cents,
        "available": lot.quantity,
        "openedAt": iso(at),
    }
    return envelope("LotOpened", show.id, payload, at)


def lot_sold_out(show: ShowSpec, sector: SectorSpec, lot: LotSpec, at: datetime) -> Message:
    payload = {"showId": show.id, "sectorId": sector.id, "lotId": lot.id, "soldOutAt": iso(at)}
    return envelope("LotSoldOut", show.id, payload, at)


def reservation_confirmed(show: ShowSpec, order: OrderSpec, at: datetime) -> Message:
    payload = {
        "reservationId": order.reservation_id,
        "showId": show.id,
        "sectorId": order.sector.id,
        "lotId": order.lot.id,
        "quantity": len(order.seats),
        "seats": [seat for seat in order.seats if seat],
        "confirmedAt": iso(at),
    }
    return envelope("ReservationConfirmed", show.id, payload, at)


def reservation_returned(show: ShowSpec, order: OrderSpec, at: datetime) -> Message:
    payload = {
        "reservationId": order.reservation_id,
        "showId": show.id,
        "sectorId": order.sector.id,
        "lotId": order.lot.id,
        "quantity": len(order.seats),
        "seats": [seat for seat in order.seats if seat],
        "returnedAt": iso(at),
    }
    return envelope("ReservationReturned", show.id, payload, at)

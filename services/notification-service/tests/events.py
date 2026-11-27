"""Mensagens de teste no formato de `contracts/`, conferidas contra os JSON Schemas.

Toda mensagem montada aqui passa pelo schema do seu tipo antes de ser usada,
então os testes nunca exercitam um formato que o order-service não publicaria.
"""

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from notification.ids import uuid7

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
TOPIC = "order.events"
QR_KEY = b"chave-de-teste"


def iso(at: datetime) -> str:
    return at.astimezone(UTC).isoformat().replace("+00:00", "Z")


@cache
def validator(event_type: str, version: int = 1) -> Draft202012Validator:
    schema = json.loads((CONTRACTS / TOPIC / f"{event_type}.v{version}.schema.json").read_text(encoding="utf-8"))
    return Draft202012Validator(schema, format_checker=FormatChecker())


def ticket_code(ticket_id: str) -> str:
    """Como o order-service assina (`TicketCodes.java`): LOTOU1.<id>.<HMAC base64url>."""
    prefix = f"LOTOU1.{ticket_id}"
    signature = hmac.new(QR_KEY, prefix.encode(), hashlib.sha256).digest()
    return f"{prefix}.{base64.urlsafe_b64encode(signature).decode().rstrip('=')}"


@dataclass(frozen=True)
class Message:
    key: str
    value: dict[str, Any]

    @property
    def event_id(self) -> str:
        return str(self.value["eventId"])

    @property
    def payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = self.value["payload"]
        return payload

    def raw(self) -> bytes:
        return json.dumps(self.value).encode()


def envelope(event_type: str, key: str, payload: dict[str, Any], *, event_id: str | None = None) -> Message:
    now = datetime.now(UTC)
    value = {
        "eventId": event_id or uuid7(),
        "type": event_type,
        "version": 1,
        "occurredAt": iso(now),
        "payload": payload,
    }
    validator(event_type).validate(value)
    return Message(key=key, value=value)


def tickets_issued(*, buyer_id: str, show_id: str, seats: list[str | None], sector: str = "Plateia") -> Message:
    order_id = uuid7()
    tickets = []
    for seat in seats:
        ticket_id = uuid7()
        tickets.append(
            {
                "ticketId": ticket_id,
                "sectorId": uuid7(),
                "sectorName": "Pista" if seat is None else sector,
                "seat": seat,
                "code": ticket_code(ticket_id),
            }
        )
    payload = {
        "orderId": order_id,
        "buyerId": buyer_id,
        "showId": show_id,
        "tickets": tickets,
        "issuedAt": iso(datetime.now(UTC)),
    }
    return envelope("TicketsIssued", order_id, payload)


def order_cancelled(
    *, buyer_id: str, show_id: str, reason: str = "PAYMENT_DECLINED", total_cents: int = 32000
) -> Message:
    order_id = uuid7()
    payload = {
        "orderId": order_id,
        "buyerId": buyer_id,
        "showId": show_id,
        "reservationId": uuid7(),
        "totalCents": total_cents,
        "reason": reason,
        "cancelledAt": iso(datetime.now(UTC)),
    }
    return envelope("OrderCancelled", order_id, payload)


def order_created(*, buyer_id: str, show_id: str) -> Message:
    order_id = uuid7()
    payload = {
        "orderId": order_id,
        "buyerId": buyer_id,
        "showId": show_id,
        "reservationId": uuid7(),
        "totalCents": 17600,
        "subtotalCents": 16000,
        "discountCents": 0,
        "serviceFeeCents": 1600,
        "serviceFeePaidBy": "BUYER",
        "couponId": None,
        "couponCode": None,
        "items": [
            {
                "sectorId": uuid7(),
                "sectorName": "Pista",
                "lotId": uuid7(),
                "lotName": "Lote 1",
                "seat": None,
                "unitPriceCents": 16000,
            }
        ],
        "createdAt": iso(datetime.now(UTC)),
    }
    return envelope("OrderCreated", order_id, payload)


def order_refunded(
    *,
    buyer_id: str,
    show_id: str,
    reason: str = "ORDER_CANCELLED",
    subtotal_cents: int = 32000,
    discount_cents: int = 3200,
    fee_paid_by: str = "BUYER",
) -> Message:
    """Estorno de um pedido com cupom; o reembolso é o total pago, taxa incluída."""
    order_id = uuid7()
    fee = subtotal_cents // 10
    refunded = subtotal_cents - discount_cents + (fee if fee_paid_by == "BUYER" else 0)
    payload = {
        "orderId": order_id,
        "buyerId": buyer_id,
        "showId": show_id,
        "reservationId": uuid7(),
        "refundedCents": refunded,
        "reason": reason,
        "refundedAt": iso(datetime.now(UTC)),
        "subtotalCents": subtotal_cents,
        "discountCents": discount_cents,
        "serviceFeeCents": fee,
        "serviceFeePaidBy": fee_paid_by,
        "couponId": uuid7() if discount_cents else None,
        "couponCode": "LANCAMENTO10" if discount_cents else None,
    }
    return envelope("OrderRefunded", order_id, payload)

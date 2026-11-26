"""Projeção do pedido (`order_view`): estado, itens, ingressos e linha do tempo.

As funções daqui são puras: recebem o documento atual e o evento e devolvem o
documento novo e o que mudou para o relatório e as vendas. Quem grava no MongoDB
é `analytics.projection`.

A ordem só é garantida por pedido (a chave do `order.events` é o `orderId`), mas
a projeção não depende dela: o estado anda pela tabela de transições, um fato
anterior que chega atrasado (um `OrderCreated` depois do `OrderConfirmed`) só
completa o documento, e a linha do tempo é ordenada pela hora do fato. O
resultado é o mesmo em qualquer ordem de chegada, que é o que o replay precisa.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from typing import Any, Final

from bson.int64 import Int64

from analytics.contracts import (
    Event,
    OrderCancelled,
    OrderConfirmed,
    OrderCreated,
    OrderItem,
    TicketsIssued,
)


class OrderStatus(StrEnum):
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"


# Tabela única de transições do pedido (docs/projeto.md, seção "Estados"), com
# os estados que a fase 3 publica. REFUNDING e REFUNDED entram na fase 6.
TRANSITIONS: Final[Mapping[OrderStatus, frozenset[OrderStatus]]] = {
    OrderStatus.PENDING: frozenset({OrderStatus.CONFIRMED, OrderStatus.CANCELLED}),
    OrderStatus.CONFIRMED: frozenset(),
    OrderStatus.CANCELLED: frozenset(),
}


def _reachable(start: OrderStatus) -> frozenset[OrderStatus]:
    seen: set[OrderStatus] = set()
    pending = [start]
    while pending:
        for target in TRANSITIONS[pending.pop()]:
            if target not in seen:
                seen.add(target)
                pending.append(target)
    return frozenset(seen)


class Step(StrEnum):
    """Como um fato de estado se encaixa no estado atual do pedido."""

    ENTERED = "entered"  # o pedido chegou a este estado agora
    LATE = "late"  # fato anterior ao estado atual, que chegou depois dele
    REPEATED = "repeated"  # o pedido já está neste estado (o mesmo fato com outro eventId)
    REFUSED = "refused"  # transição fora da tabela: o fato é recusado


def step(current: OrderStatus | None, reached: OrderStatus) -> Step:
    if current is None:
        return Step.ENTERED
    if reached == current:
        return Step.REPEATED
    if reached in TRANSITIONS[current]:
        return Step.ENTERED
    if current in _reachable(reached):
        return Step.LATE
    return Step.REFUSED


@dataclass
class StatementDelta:
    """O que um evento de pedido soma ao relatório do show."""

    orders_created: int = 0
    confirmed_orders: int = 0
    tickets_sold: int = 0
    gross_sales_cents: int = 0
    cancelled_orders: int = 0
    cancelled_reason: str | None = None
    tickets_issued: int = 0

    def is_empty(self) -> bool:
        return self == StatementDelta()


@dataclass(frozen=True)
class SaleLine:
    """Ingressos vendidos de um lote, agregados para o `sales_by_sector`."""

    sector_id: str
    lot_id: str
    tickets: int
    revenue_cents: int


@dataclass
class OrderChange:
    view: dict[str, Any]
    step: Step | None
    statement: StatementDelta = field(default_factory=StatementDelta)
    sales: list[SaleLine] = field(default_factory=list)
    sold_at: datetime | None = None


def new_view(event: Event, show: Mapping[str, Any] | None) -> dict[str, Any]:
    payload = event.payload
    assert isinstance(payload, OrderCreated | OrderConfirmed | OrderCancelled | TicketsIssued)
    return {
        "_id": payload.order_id,
        "orderId": payload.order_id,
        "showId": payload.show_id,
        "buyerId": payload.buyer_id,
        "reservationId": getattr(payload, "reservation_id", None),
        "status": None,
        "totalCents": None,
        "items": [],
        "tickets": [],
        "createdAt": None,
        "confirmedAt": None,
        "cancelledAt": None,
        "cancelReason": None,
        "ticketsIssuedAt": None,
        "timeline": [],
        "show": dict(show) if show is not None else None,
    }


def apply(view: dict[str, Any] | None, event: Event, show: Mapping[str, Any] | None) -> OrderChange:
    """Aplica um evento de pedido. `show` é o resumo do show, usado se o pedido é novo."""
    is_new = view is None
    current = new_view(event, show) if view is None else _copy(view)
    payload = event.payload
    match payload:
        case OrderCreated():
            change = _created(current, event, payload)
        case OrderConfirmed():
            change = _confirmed(current, event, payload)
        case OrderCancelled():
            change = _cancelled(current, event, payload)
        case TicketsIssued():
            change = _tickets_issued(current, event, payload)
        case _:
            raise TypeError(f"evento que não é de pedido: {event.type}")
    if is_new:
        change.statement.orders_created = 1
    return change


def _created(view: dict[str, Any], event: Event, payload: OrderCreated) -> OrderChange:
    result = step(_status(view), OrderStatus.PENDING)
    if result in (Step.ENTERED, Step.LATE):
        view["createdAt"] = payload.created_at
        view["reservationId"] = view["reservationId"] or payload.reservation_id
        if not view["items"]:
            # O OrderConfirmed traz os mesmos itens e prevalece se chegar antes.
            view["items"] = _items(payload.items)
            view["totalCents"] = Int64(payload.total_cents)
        _add_to_timeline(view, "CREATED", payload.created_at, event)
    if result is Step.ENTERED:
        view["status"] = OrderStatus.PENDING.value
    return OrderChange(view=view, step=result)


def _confirmed(view: dict[str, Any], event: Event, payload: OrderConfirmed) -> OrderChange:
    result = step(_status(view), OrderStatus.CONFIRMED)
    change = OrderChange(view=view, step=result)
    if result is not Step.ENTERED:
        return change
    view["status"] = OrderStatus.CONFIRMED.value
    view["confirmedAt"] = payload.confirmed_at
    view["reservationId"] = payload.reservation_id
    view["items"] = _items(payload.items)
    view["totalCents"] = Int64(payload.total_cents)
    _add_to_timeline(view, "CONFIRMED", payload.confirmed_at, event)

    gross = sum(item.unit_price_cents for item in payload.items)
    change.statement.confirmed_orders = 1
    change.statement.tickets_sold = len(payload.items)
    change.statement.gross_sales_cents = gross
    change.sales = sale_lines(payload.items)
    change.sold_at = payload.confirmed_at
    return change


def _cancelled(view: dict[str, Any], event: Event, payload: OrderCancelled) -> OrderChange:
    result = step(_status(view), OrderStatus.CANCELLED)
    change = OrderChange(view=view, step=result)
    if result is not Step.ENTERED:
        return change
    view["status"] = OrderStatus.CANCELLED.value
    view["cancelledAt"] = payload.cancelled_at
    view["cancelReason"] = payload.reason
    view["reservationId"] = payload.reservation_id
    if view["totalCents"] is None:
        view["totalCents"] = Int64(payload.total_cents)
    _add_to_timeline(view, "CANCELLED", payload.cancelled_at, event, reason=payload.reason)
    change.statement.cancelled_orders = 1
    change.statement.cancelled_reason = payload.reason
    return change


def _tickets_issued(view: dict[str, Any], event: Event, payload: TicketsIssued) -> OrderChange:
    change = OrderChange(view=view, step=None)
    if view["tickets"]:
        return change  # os ingressos do pedido já foram emitidos
    view["tickets"] = [
        {
            "ticketId": ticket.ticket_id,
            "sectorId": ticket.sector_id,
            "sectorName": ticket.sector_name,
            "seat": ticket.seat,
        }
        for ticket in payload.tickets
    ]
    view["ticketsIssuedAt"] = payload.issued_at
    _add_to_timeline(view, "TICKETS_ISSUED", payload.issued_at, event)
    change.statement.tickets_issued = len(payload.tickets)
    return change


def sale_lines(items: list[OrderItem]) -> list[SaleLine]:
    """Agrega os itens por setor e lote, na ordem em que aparecem."""
    totals: dict[tuple[str, str], list[int]] = {}
    for item in items:
        line = totals.setdefault((item.sector_id, item.lot_id), [0, 0])
        line[0] += 1
        line[1] += item.unit_price_cents
    return [
        SaleLine(sector_id=sector, lot_id=lot, tickets=tickets, revenue_cents=revenue)
        for (sector, lot), (tickets, revenue) in totals.items()
    ]


def _status(view: Mapping[str, Any]) -> OrderStatus | None:
    status = view.get("status")
    return OrderStatus(status) if status is not None else None


def _items(items: list[OrderItem]) -> list[dict[str, Any]]:
    return [
        {
            "sectorId": item.sector_id,
            "sectorName": item.sector_name,
            "lotId": item.lot_id,
            "lotName": item.lot_name,
            "seat": item.seat,
            "unitPriceCents": Int64(item.unit_price_cents),
        }
        for item in items
    ]


def _add_to_timeline(
    view: dict[str, Any], status: str, at: datetime, event: Event, *, reason: str | None = None
) -> None:
    timeline: list[dict[str, Any]] = view["timeline"]
    if any(entry["eventId"] == event.event_id for entry in timeline):
        return
    entry: dict[str, Any] = {"status": status, "at": at, "eventId": event.event_id}
    if reason is not None:
        entry["reason"] = reason
    timeline.append(entry)
    timeline.sort(key=lambda e: (e["at"], e["eventId"]))


def _copy(view: Mapping[str, Any]) -> dict[str, Any]:
    copied = dict(view)
    for key in ("items", "tickets", "timeline"):
        copied[key] = [dict(entry) for entry in view.get(key) or []]
    return copied

"""Projeção do pedido (`order_view`): estado, valores, itens, ingressos e linha do tempo.

As funções daqui são puras: recebem o documento atual e o evento e devolvem o
documento novo e o que mudou para o relatório e as vendas. Quem grava no MongoDB
é `analytics.projection`.

A ordem só é garantida por pedido (a chave do `order.events` é o `orderId`), e a
entrada na portaria vem de outro tópico (`checkin.events`, chave `showId`). A
projeção não depende de ordem nenhuma:

- O estado anda pela tabela de transições. Cada fato é uma transição da tabela
  (de onde parte, aonde chega). Um fato anterior ao estado atual, que chegou
  atrasado (um `OrderConfirmed` depois do `OrderRefunded`), só completa o
  documento; um fato à frente, cujo passo intermediário ainda não chegou (ou
  nunca é publicado, como o reprocessamento manual de `REFUND_FAILED` para
  `REFUNDING`), leva o pedido adiante pelo caminho da tabela.
- O que vai para o relatório e as vendas é contado uma vez por tipo de fato
  (a confirmação, o estorno), quando o fato chega pela primeira vez, esteja ele
  na frente ou atrás do estado atual. O efeito que depende de dois fatos (tirar
  das vendas um pedido reembolsado precisa dos itens da confirmação) é aplicado
  por quem chegar por último.
- O estado de cada ingresso é recalculado a partir dos fatos guardados (entrada
  e cancelamento), passando pela tabela do ingresso na ordem da hora de cada um.

O resultado é o mesmo em qualquer ordem de chegada, que é o que o replay precisa.
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
    OrderRefunded,
    OrderRefundFailed,
    Pricing,
    TicketCheckedIn,
    TicketsCancelled,
    TicketsIssued,
)


class OrderStatus(StrEnum):
    PENDING = "PENDING"
    CONFIRMED = "CONFIRMED"
    CANCELLED = "CANCELLED"
    REFUNDING = "REFUNDING"
    REFUND_FAILED = "REFUND_FAILED"
    REFUNDED = "REFUNDED"


# Tabela única de transições do pedido (docs/projeto.md, seção "Estados").
TRANSITIONS: Final[Mapping[OrderStatus, frozenset[OrderStatus]]] = {
    OrderStatus.PENDING: frozenset({OrderStatus.CONFIRMED, OrderStatus.CANCELLED}),
    OrderStatus.CONFIRMED: frozenset({OrderStatus.REFUNDING}),
    OrderStatus.CANCELLED: frozenset(),
    OrderStatus.REFUNDING: frozenset({OrderStatus.REFUNDED, OrderStatus.REFUND_FAILED}),
    OrderStatus.REFUND_FAILED: frozenset({OrderStatus.REFUNDING}),
    OrderStatus.REFUNDED: frozenset(),
}


@dataclass(frozen=True)
class Fact:
    """Um evento de pedido como transição da tabela: de onde parte e aonde chega."""

    reached: OrderStatus
    sources: frozenset[OrderStatus]
    # Fato que pode acontecer mais de uma vez de verdade (cada falha de estorno,
    # depois de um reprocessamento manual): toda ocorrência vai para a linha do tempo.
    repeatable: bool = False


FACTS: Final[Mapping[str, Fact]] = {
    "OrderCreated": Fact(OrderStatus.PENDING, frozenset()),
    "OrderConfirmed": Fact(OrderStatus.CONFIRMED, frozenset({OrderStatus.PENDING})),
    "OrderCancelled": Fact(OrderStatus.CANCELLED, frozenset({OrderStatus.PENDING})),
    # O cancelamento dos ingressos é o começo do reembolso.
    "TicketsCancelled": Fact(OrderStatus.REFUNDING, frozenset({OrderStatus.CONFIRMED})),
    "OrderRefundFailed": Fact(OrderStatus.REFUND_FAILED, frozenset({OrderStatus.REFUNDING}), repeatable=True),
    "OrderRefunded": Fact(OrderStatus.REFUNDED, frozenset({OrderStatus.REFUNDING})),
}

for _name, _fact in FACTS.items():
    assert all(_fact.reached in TRANSITIONS[source] for source in _fact.sources), f"{_name} fora da tabela"


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


def step(current: OrderStatus | None, fact: Fact) -> Step:
    if current is None:
        return Step.ENTERED
    if fact.reached == current:
        return Step.REPEATED
    if current in fact.sources:
        return Step.ENTERED
    if current in _reachable(fact.reached):
        return Step.LATE
    if any(source in _reachable(current) for source in fact.sources):
        # À frente: o passo intermediário chega depois, ou não é publicado.
        return Step.ENTERED
    return Step.REFUSED


class TicketStatus(StrEnum):
    VALID = "VALID"
    USED = "USED"
    CANCELLED = "CANCELLED"


# Tabela de transições do ingresso. USED e CANCELLED são finais: um ingresso
# usado não é cancelado, e um cancelado não entra.
TICKET_TRANSITIONS: Final[Mapping[TicketStatus, frozenset[TicketStatus]]] = {
    TicketStatus.VALID: frozenset({TicketStatus.USED, TicketStatus.CANCELLED}),
    TicketStatus.USED: frozenset(),
    TicketStatus.CANCELLED: frozenset(),
}


@dataclass
class StatementDelta:
    """O que um evento de pedido soma ao relatório do show (valores podem ser negativos)."""

    orders_created: int = 0
    confirmed_orders: int = 0
    tickets_sold: int = 0
    gross_sales_cents: int = 0
    discounts_cents: int = 0
    platform_fee_cents: int = 0
    buyer_fees_cents: int = 0
    cancelled_orders: int = 0
    cancelled_reason: str | None = None
    tickets_issued: int = 0
    refunded_orders: int = 0
    refunds_cents: int = 0
    tickets_refunded: int = 0

    def is_empty(self) -> bool:
        return self == StatementDelta()


@dataclass(frozen=True)
class SaleLine:
    """Ingressos de um lote, agregados para o `sales_by_sector`. Negativa no estorno."""

    sector_id: str
    lot_id: str
    tickets: int
    revenue_cents: int


@dataclass(frozen=True)
class SalesChange:
    """O que vai para o `sales_by_sector`, na hora (UTC) da confirmação do pedido."""

    sold_at: datetime
    lines: list[SaleLine]
    # +1 na venda, -1 no estorno, 0 quando a venda chega já estornada.
    orders: int


@dataclass(frozen=True)
class Checkin:
    """Entrada nova na portaria, para o contador por portão."""

    gate: str
    at: datetime


@dataclass
class OrderChange:
    view: dict[str, Any]
    step: Step | None
    statement: StatementDelta = field(default_factory=StatementDelta)
    sales: SalesChange | None = None
    checkin: Checkin | None = None
    # O fato foi aplicado pela primeira vez agora: vai para o feed do painel.
    first_time: bool = False


def new_view(order_id: str, show_id: str, show: Mapping[str, Any] | None) -> dict[str, Any]:
    return {
        "_id": order_id,
        "orderId": order_id,
        "showId": show_id,
        "buyerId": None,
        "reservationId": None,
        "status": None,
        "totalCents": None,
        "subtotalCents": None,
        "discountCents": None,
        "serviceFeeCents": None,
        "serviceFeePaidBy": None,
        "couponId": None,
        "couponCode": None,
        "items": [],
        "tickets": [],
        "checkins": [],
        "createdAt": None,
        "confirmedAt": None,
        "cancelledAt": None,
        "cancelReason": None,
        "ticketsIssuedAt": None,
        "ticketsCancelledAt": None,
        "cancelledTicketIds": [],
        "refundReason": None,
        "refundedAt": None,
        "refundedCents": None,
        "refundFailedAt": None,
        "refundAttempts": None,
        "timeline": [],
        "show": dict(show) if show is not None else None,
    }


def apply(view: dict[str, Any] | None, event: Event, show: Mapping[str, Any] | None) -> OrderChange:
    """Aplica um evento do pedido. `show` é o resumo do show, usado se o pedido é novo."""
    payload = event.payload
    if not isinstance(
        payload,
        OrderCreated
        | OrderConfirmed
        | OrderCancelled
        | TicketsIssued
        | TicketsCancelled
        | OrderRefunded
        | OrderRefundFailed
        | TicketCheckedIn,
    ):
        raise TypeError(f"evento que não é de pedido: {event.type}")
    # O pedido conta como criado no primeiro fato do `order.events` (todo fato
    # dele entra na linha do tempo). A entrada na portaria, que pode chegar antes
    # por outro tópico, cria o documento mas não mexe no relatório.
    is_new = not isinstance(payload, TicketCheckedIn) and not (view and view["timeline"])
    current = new_view(payload.order_id, payload.show_id, show) if view is None else _copy(view)
    buyer_id = getattr(payload, "buyer_id", None)
    if current["buyerId"] is None and buyer_id is not None:
        current["buyerId"] = buyer_id

    match payload:
        case OrderCreated():
            change = _created(current, event, payload)
        case OrderConfirmed():
            change = _confirmed(current, event, payload)
        case OrderCancelled():
            change = _cancelled(current, event, payload)
        case TicketsIssued():
            change = _tickets_issued(current, event, payload)
        case TicketsCancelled():
            change = _tickets_cancelled(current, event, payload)
        case OrderRefundFailed():
            change = _refund_failed(current, event, payload)
        case OrderRefunded():
            change = _refunded(current, event, payload)
        case TicketCheckedIn():
            change = _checked_in(current, payload)
    _recompute_tickets(change.view)
    if is_new:
        change.statement.orders_created = 1
    return change


# ---------------------------------------------------------------- fatos


def _created(view: dict[str, Any], event: Event, payload: OrderCreated) -> OrderChange:
    result = _step(view, event)
    if result in (Step.ENTERED, Step.LATE):
        view["createdAt"] = payload.created_at
        view["reservationId"] = view["reservationId"] or payload.reservation_id
        if not view["items"]:
            # O OrderConfirmed traz os mesmos itens e valores e prevalece se chegar antes.
            view["items"] = _items(payload.items)
            _set_pricing(view, payload)
        _add_to_timeline(view, "CREATED", payload.created_at, event)
    if result is Step.ENTERED:
        view["status"] = OrderStatus.PENDING.value
    return OrderChange(view=view, step=result)


def _confirmed(view: dict[str, Any], event: Event, payload: OrderConfirmed) -> OrderChange:
    result = _step(view, event)
    change = OrderChange(view=view, step=result)
    if result not in (Step.ENTERED, Step.LATE) or view["confirmedAt"] is not None:
        return change
    if result is Step.ENTERED:
        view["status"] = OrderStatus.CONFIRMED.value
    view["confirmedAt"] = payload.confirmed_at
    view["reservationId"] = payload.reservation_id
    view["items"] = _items(payload.items)
    _set_pricing(view, payload)
    _add_to_timeline(view, "CONFIRMED", payload.confirmed_at, event)

    delta = change.statement
    delta.confirmed_orders = 1
    delta.tickets_sold = len(payload.items)
    delta.gross_sales_cents = payload.subtotal
    delta.discounts_cents = payload.discount_cents
    _add_fee(delta, payload, sign=1)
    if view["refundedAt"] is None:
        change.sales = SalesChange(payload.confirmed_at, sale_lines(payload.items, payload.discount_cents), orders=1)
    else:
        # O estorno chegou antes: a venda entra nas vendas já desfeita (zero), e
        # os ingressos que voltaram são contados agora que os itens são conhecidos.
        lines = [SaleLine(line.sector_id, line.lot_id, 0, 0) for line in sale_lines(payload.items, 0)]
        change.sales = SalesChange(payload.confirmed_at, lines, orders=0)
        delta.tickets_refunded = len(payload.items)
    change.first_time = True
    return change


def _cancelled(view: dict[str, Any], event: Event, payload: OrderCancelled) -> OrderChange:
    result = _step(view, event)
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
    change.first_time = True
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


def _tickets_cancelled(view: dict[str, Any], event: Event, payload: TicketsCancelled) -> OrderChange:
    result = _step(view, event)
    change = OrderChange(view=view, step=result)
    if result not in (Step.ENTERED, Step.LATE) or view["ticketsCancelledAt"] is not None:
        return change
    if result is Step.ENTERED:
        view["status"] = OrderStatus.REFUNDING.value
    view["ticketsCancelledAt"] = payload.cancelled_at
    view["cancelledTicketIds"] = sorted(payload.ticket_ids)
    view["refundReason"] = payload.reason
    _add_to_timeline(view, "REFUNDING", payload.cancelled_at, event, reason=payload.reason)
    change.first_time = True
    return change


def _refund_failed(view: dict[str, Any], event: Event, payload: OrderRefundFailed) -> OrderChange:
    result = _step(view, event)
    change = OrderChange(view=view, step=result)
    if result is Step.REFUSED:
        return change
    if result is Step.ENTERED:
        view["status"] = OrderStatus.REFUND_FAILED.value
    # Pode falhar de novo depois de um reprocessamento: fica a falha mais recente.
    last = view["refundFailedAt"]
    if last is None or payload.failed_at > last:
        view["refundFailedAt"] = payload.failed_at
        view["refundAttempts"] = payload.attempts
    _add_to_timeline(view, "REFUND_FAILED", payload.failed_at, event)
    change.first_time = result is Step.ENTERED
    return change


def _refunded(view: dict[str, Any], event: Event, payload: OrderRefunded) -> OrderChange:
    result = _step(view, event)
    change = OrderChange(view=view, step=result)
    if result not in (Step.ENTERED, Step.LATE) or view["refundedAt"] is not None:
        return change
    if result is Step.ENTERED:
        view["status"] = OrderStatus.REFUNDED.value
    view["reservationId"] = view["reservationId"] or payload.reservation_id
    view["refundedAt"] = payload.refunded_at
    view["refundedCents"] = Int64(payload.refunded_cents)
    view["refundReason"] = payload.reason
    _add_to_timeline(view, "REFUNDED", payload.refunded_at, event, reason=payload.reason)

    # O estorno devolve ao comprador os ingressos (com o desconto) e a taxa. A
    # venda continua nas vendas brutas e no desconto; o valor dos ingressos vai
    # para os reembolsos e a taxa sai de onde foi contada (a plataforma não fica
    # com a taxa de um pedido estornado, e o produtor não paga a que absorveu).
    delta = change.statement
    delta.refunded_orders = 1
    delta.refunds_cents = payload.subtotal - payload.discount_cents
    _add_fee(delta, payload, sign=-1)
    if view["confirmedAt"] is not None:
        # A venda já estava nas vendas por setor: sai da mesma hora em que entrou.
        lines = sale_lines(_order_items(view["items"]), int(view["discountCents"] or 0))
        change.sales = SalesChange(
            view["confirmedAt"],
            [SaleLine(line.sector_id, line.lot_id, -line.tickets, -line.revenue_cents) for line in lines],
            orders=-1,
        )
        delta.tickets_refunded = len(view["items"])
    change.first_time = True
    return change


def _checked_in(view: dict[str, Any], payload: TicketCheckedIn) -> OrderChange:
    change = OrderChange(view=view, step=None)
    checkins: list[dict[str, Any]] = view["checkins"]
    if any(entry["ticketId"] == payload.ticket_id for entry in checkins):
        return change  # cada ingresso entra uma vez só; a repetição não conta
    checkins.append(
        {
            "ticketId": payload.ticket_id,
            "sectorId": payload.sector_id,
            "sectorName": payload.sector_name,
            "seat": payload.seat,
            "gate": payload.gate,
            "at": payload.checked_in_at,
        }
    )
    checkins.sort(key=lambda entry: entry["ticketId"])
    change.checkin = Checkin(gate=payload.gate, at=payload.checked_in_at)
    change.first_time = True
    return change


# ------------------------------------------------------------- ingressos


def ticket_status(
    checkin: Mapping[str, Any] | None, cancelled_at: datetime | None
) -> tuple[TicketStatus, Mapping[str, Any] | None]:
    """Estado do ingresso: os fatos dele passam pela tabela na ordem da hora.

    Uma entrada depois do cancelamento (ou o contrário) é recusada pela tabela,
    não pela ordem de chegada. Na mesma hora, a entrada vem primeiro.
    """
    facts: list[tuple[datetime, int, TicketStatus]] = []
    if checkin is not None:
        facts.append((checkin["at"], 0, TicketStatus.USED))
    if cancelled_at is not None:
        facts.append((cancelled_at, 1, TicketStatus.CANCELLED))
    status = TicketStatus.VALID
    for _, _, target in sorted(facts, key=lambda fact: (fact[0], fact[1])):
        if target in TICKET_TRANSITIONS[status]:
            status = target
    return status, checkin if status is TicketStatus.USED else None


def _recompute_tickets(view: dict[str, Any]) -> None:
    checkins = {entry["ticketId"]: entry for entry in view["checkins"]}
    cancelled = set(view["cancelledTicketIds"])
    for ticket in view["tickets"]:
        cancelled_at = view["ticketsCancelledAt"] if ticket["ticketId"] in cancelled else None
        status, used = ticket_status(checkins.get(ticket["ticketId"]), cancelled_at)
        ticket["status"] = status.value
        ticket["usedAt"] = used["at"] if used else None
        ticket["gate"] = used["gate"] if used else None
        ticket["cancelledAt"] = cancelled_at if status is TicketStatus.CANCELLED else None


# ------------------------------------------------------------------ apoio


def sale_lines(items: list[OrderItem], discount_cents: int) -> list[SaleLine]:
    """Agrega os itens por setor e lote, na ordem em que aparecem, já com o desconto.

    A receita de uma linha é o valor dos ingressos menos a parte dela no desconto
    do cupom, sem a taxa. O desconto é por pedido e se divide entre as linhas na
    proporção do valor, arredondado para baixo; o centavo que sobra fica com a
    primeira linha. (Uma reserva é de um setor e um lote, então na prática o
    pedido tem uma linha só e o desconto inteiro é dela.)
    """
    totals: dict[tuple[str, str], list[int]] = {}
    for item in items:
        line = totals.setdefault((item.sector_id, item.lot_id), [0, 0])
        line[0] += 1
        line[1] += item.unit_price_cents
    subtotal = sum(gross for _, gross in totals.values())
    discount = min(discount_cents, subtotal)
    shares = [discount * gross // subtotal if subtotal else 0 for _, gross in totals.values()]
    if shares:
        shares[0] += discount - sum(shares)
    return [
        SaleLine(sector_id=sector, lot_id=lot, tickets=tickets, revenue_cents=gross - share)
        for ((sector, lot), (tickets, gross)), share in zip(totals.items(), shares, strict=True)
    ]


def _step(view: Mapping[str, Any], event: Event) -> Step:
    status = view.get("status")
    return step(OrderStatus(status) if status is not None else None, FACTS[event.type])


def _set_pricing(view: dict[str, Any], payload: OrderCreated | OrderConfirmed) -> None:
    view["totalCents"] = Int64(payload.total_cents)
    view["subtotalCents"] = Int64(payload.subtotal)
    view["discountCents"] = Int64(payload.discount_cents)
    view["serviceFeeCents"] = Int64(payload.service_fee_cents)
    view["serviceFeePaidBy"] = payload.service_fee_paid_by
    view["couponId"] = payload.coupon_id
    view["couponCode"] = payload.coupon_code


def _add_fee(delta: StatementDelta, pricing: Pricing, *, sign: int) -> None:
    if pricing.service_fee_paid_by == "PRODUCER":
        delta.platform_fee_cents += sign * pricing.service_fee_cents
    else:
        delta.buyer_fees_cents += sign * pricing.service_fee_cents


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


def _order_items(docs: list[Mapping[str, Any]]) -> list[OrderItem]:
    return [OrderItem.model_validate(doc) for doc in docs]


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
    for key in ("items", "tickets", "timeline", "checkins"):
        copied[key] = [dict(entry) for entry in view.get(key) or []]
    copied["cancelledTicketIds"] = list(view.get("cancelledTicketIds") or [])
    # Documento gravado antes da fase 6: os campos novos nascem vazios.
    for key, value in new_view(view["_id"], view["showId"], None).items():
        copied.setdefault(key, value)
    return copied

"""Relatório financeiro do produtor, por show (`producer_statements`).

Valor a receber = vendas brutas − descontos de cupom − reembolsos − taxa de
serviço absorvida pelo produtor (docs/projeto.md, "Financeiro"). Cupons,
reembolsos e a taxa entram na fase 6; até lá os três campos existem e valem 0,
para o formato do relatório não mudar quando chegarem.

O relatório é parcial até o show terminar (status `FINISHED` no catálogo).
"""

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from bson.int64 import Int64

from analytics.domain import shows
from analytics.domain.orders import StatementDelta

CURRENCY = "BRL"
_MONEY = ("grossSalesCents", "discountsCents", "refundsCents", "platformFeeCents", "receivableCents")


def new(show_id: str) -> dict[str, Any]:
    statement: dict[str, Any] = {
        "_id": show_id,
        "showId": show_id,
        "producerId": None,
        "show": None,
        "currency": CURRENCY,
        "ordersCreated": 0,
        "confirmedOrders": 0,
        "ticketsSold": 0,
        "ticketsIssued": 0,
        "cancelledOrders": 0,
        "cancelledByReason": {},
        "lastEventAt": None,
        "partial": True,
    }
    for field in _MONEY:
        statement[field] = Int64(0)
    return statement


def attach_show(statement: dict[str, Any], show: Mapping[str, Any]) -> None:
    """Copia do catálogo o dono e o resumo do show, e recalcula o que depende do status."""
    summary = shows.summary(show)
    assert summary is not None
    statement["producerId"] = show["producerId"]
    statement["show"] = {**summary, "status": show["status"]}
    _recompute(statement)


def add(statement: dict[str, Any], delta: StatementDelta, at: datetime) -> None:
    """Soma o efeito de um evento de pedido. `at` é a hora do fato."""
    statement["ordersCreated"] += delta.orders_created
    statement["confirmedOrders"] += delta.confirmed_orders
    statement["ticketsSold"] += delta.tickets_sold
    statement["ticketsIssued"] += delta.tickets_issued
    statement["cancelledOrders"] += delta.cancelled_orders
    if delta.cancelled_reason is not None:
        by_reason = dict(statement["cancelledByReason"])
        by_reason[delta.cancelled_reason] = by_reason.get(delta.cancelled_reason, 0) + 1
        # Chaves em ordem alfabética: o documento não depende da ordem de chegada.
        statement["cancelledByReason"] = dict(sorted(by_reason.items()))
    statement["grossSalesCents"] = Int64(statement["grossSalesCents"] + delta.gross_sales_cents)
    last = statement["lastEventAt"]
    statement["lastEventAt"] = at if last is None or at > last else last
    _recompute(statement)


def receivable_cents(gross: int, discounts: int, refunds: int, platform_fee: int) -> int:
    return gross - discounts - refunds - platform_fee


def _recompute(statement: dict[str, Any]) -> None:
    statement["receivableCents"] = Int64(
        receivable_cents(
            statement["grossSalesCents"],
            statement["discountsCents"],
            statement["refundsCents"],
            statement["platformFeeCents"],
        )
    )
    show = statement["show"]
    statement["partial"] = show is None or show["status"] != "FINISHED"

"""Relatório financeiro do produtor, por show (`producer_statements`).

Valor a receber = vendas brutas − descontos de cupom − reembolsos − taxa de
serviço absorvida pelo produtor (docs/projeto.md, "Financeiro"; contrato em
`contracts/api-fase-6.md`). Cada campo, em centavos:

- `grossSalesCents`: subtotal (ingressos ao preço da reserva) de todo pedido
  que chegou a `CONFIRMED`, reembolsado ou não;
- `discountsCents`: desconto do cupom desses mesmos pedidos;
- `refundsCents`: subtotal − desconto dos pedidos reembolsados (`OrderRefunded`);
- `platformFeeCents`: taxa dos pedidos em que o produtor absorve a taxa
  (`PRODUCER`), menos a dos reembolsados;
- `buyerFeesCents`: taxa paga pelos compradores (`BUYER`), menos a dos
  reembolsados; informativo, não entra no valor a receber;
- `receivableCents`: bruto − descontos − reembolsos − taxa absorvida.

Um pedido reembolsado continua nas vendas brutas e no desconto (foi vendido) e
o que o produtor recebeu por ele vai para os reembolsos; a taxa dele sai da
taxa absorvida, porque o estorno devolve tudo ao comprador e a plataforma não
fica com taxa de pedido estornado. Assim o pedido reembolsado soma zero no
valor a receber: bruto − desconto − (bruto − desconto) − 0.

Só o estorno concluído conta: um pedido em `REFUNDING` ou `REFUND_FAILED` ainda
está com o dinheiro do comprador, e continua no valor a receber até o estorno.

O relatório é parcial até o show terminar (status `FINISHED` no catálogo).
"""

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from bson.int64 import Int64

from analytics.domain import shows
from analytics.domain.orders import StatementDelta

CURRENCY = "BRL"
_MONEY = (
    "grossSalesCents",
    "discountsCents",
    "refundsCents",
    "platformFeeCents",
    "buyerFeesCents",
    "receivableCents",
)
# Campo do documento -> campo do StatementDelta somado a ele.
_SUMS = {
    "ordersCreated": "orders_created",
    "confirmedOrders": "confirmed_orders",
    "ticketsSold": "tickets_sold",
    "ticketsIssued": "tickets_issued",
    "cancelledOrders": "cancelled_orders",
    "refundedOrders": "refunded_orders",
    "ticketsRefunded": "tickets_refunded",
}
_MONEY_SUMS = {
    "grossSalesCents": "gross_sales_cents",
    "discountsCents": "discounts_cents",
    "refundsCents": "refunds_cents",
    "platformFeeCents": "platform_fee_cents",
    "buyerFeesCents": "buyer_fees_cents",
}


def new(show_id: str) -> dict[str, Any]:
    statement: dict[str, Any] = {
        "_id": show_id,
        "showId": show_id,
        "producerId": None,
        "show": None,
        "currency": CURRENCY,
        "cancelledByReason": {},
        "lastEventAt": None,
        "partial": True,
    }
    for field in _SUMS:
        statement[field] = 0
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
    _upgrade(statement)
    for doc_field, delta_field in _SUMS.items():
        statement[doc_field] += getattr(delta, delta_field)
    for doc_field, delta_field in _MONEY_SUMS.items():
        statement[doc_field] = Int64(statement[doc_field] + getattr(delta, delta_field))
    if delta.cancelled_reason is not None:
        by_reason = dict(statement["cancelledByReason"])
        by_reason[delta.cancelled_reason] = by_reason.get(delta.cancelled_reason, 0) + 1
        # Chaves em ordem alfabética: o documento não depende da ordem de chegada.
        statement["cancelledByReason"] = dict(sorted(by_reason.items()))
    last = statement["lastEventAt"]
    statement["lastEventAt"] = at if last is None or at > last else last
    _recompute(statement)


def receivable_cents(gross: int, discounts: int, refunds: int, platform_fee: int) -> int:
    return gross - discounts - refunds - platform_fee


def net_tickets(statement: Mapping[str, Any]) -> int:
    """Ingressos vendidos e não reembolsados."""
    return int(statement.get("ticketsSold", 0)) - int(statement.get("ticketsRefunded", 0))


def net_revenue_cents(statement: Mapping[str, Any]) -> int:
    """Receita dos ingressos: bruto − descontos − reembolsos, sem a taxa (a mesma das vendas por setor)."""
    return (
        int(statement.get("grossSalesCents", 0))
        - int(statement.get("discountsCents", 0))
        - int(statement.get("refundsCents", 0))
    )


def _upgrade(statement: dict[str, Any]) -> None:
    """Documento gravado antes da fase 6: os campos novos nascem zerados."""
    for field in _SUMS:
        statement.setdefault(field, 0)
    for field in _MONEY:
        statement.setdefault(field, Int64(0))


def _recompute(statement: dict[str, Any]) -> None:
    _upgrade(statement)
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

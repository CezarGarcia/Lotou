"""Uma noite de vendas realista, com IDs novos a cada chamada.

Dois shows de produtores diferentes. No show A (o comprador paga a taxa):
pedidos confirmados nos dois setores, um com cupom de valor fixo, um pagamento
recusado, uma reserva expirada, um pedido com cupom percentual cancelado pelo
comprador e reembolsado, virada de lote por esgotamento, entradas em dois
portões, título alterado depois das vendas e uma versão antiga do show
republicada. No show B (o produtor absorve a taxa), o primeiro pedido chega
antes do show; há um pedido com cupom, um pagamento recusado e um reembolso que
falha, é reprocessado e conclui. Mais o ruído de um consumidor real:
repetições, tipos que o analytics ignora e mensagens fora do contrato.

Os números esperados estão em `EXPECTED_STATEMENT_A` e `EXPECTED_STATEMENT_B`.
"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from tests import events
from tests.events import Coupon, LotSpec, Message, OrderSpec, SectorSpec, ShowSpec

DAY = datetime(2026, 11, 26, tzinfo=UTC)

# Show A, o comprador paga a taxa (10% por ingresso):
#   o1 Plateia 2 x 160,00 = 320,00, taxa 32,00
#   o2 Pista   3 x 120,00 = 360,00, taxa 36,00
#   o5 Pista   4 x 150,00 = 600,00, cupom de 50,00, taxa 60,00
#   o7 Plateia 1 x 160,00 = 160,00, cupom de 10% (16,00), taxa 16,00, reembolsado
#   o3 e o4 cancelados antes de confirmar: não entram no dinheiro
# bruto 1.440,00; descontos 66,00; reembolsos 160,00 - 16,00 = 144,00; taxa
# absorvida 0; taxa dos compradores 32 + 36 + 60 = 128,00 (a do o7 voltou ao
# comprador); a receber 1.440 - 66 - 144 = 1.230,00.
EXPECTED_STATEMENT_A = {
    "grossSalesCents": 144000,
    "discountsCents": 6600,
    "refundsCents": 14400,
    "platformFeeCents": 0,
    "buyerFeesCents": 12800,
    "receivableCents": 123000,
    "ordersCreated": 6,
    "confirmedOrders": 4,
    "cancelledOrders": 2,
    "cancelledByReason": {"PAYMENT_DECLINED": 1, "RESERVATION_EXPIRED": 1},
    "refundedOrders": 1,
    "ticketsSold": 10,
    "ticketsRefunded": 1,
    "ticketsIssued": 6,
}

# Show B, o produtor absorve a taxa:
#   o6 2 x 90,00 = 180,00, taxa 18,00
#   o8 3 x 90,00 = 270,00, cupom de 15% (40,50), taxa 27,00
#   o9 1 x 90,00 =  90,00, taxa 9,00, reembolsado (depois de uma falha de estorno)
#   o10 cancelado (pagamento recusado)
# bruto 540,00; descontos 40,50; reembolsos 90,00; taxa absorvida 18 + 27 = 45,00
# (a do o9 não é cobrada do produtor); a receber 540 - 40,50 - 90 - 45 = 364,50.
EXPECTED_STATEMENT_B = {
    "grossSalesCents": 54000,
    "discountsCents": 4050,
    "refundsCents": 9000,
    "platformFeeCents": 4500,
    "buyerFeesCents": 0,
    "receivableCents": 36450,
    "ordersCreated": 4,
    "confirmedOrders": 3,
    "cancelledOrders": 1,
    "cancelledByReason": {"PAYMENT_DECLINED": 1},
    "refundedOrders": 1,
    "ticketsSold": 6,
    "ticketsRefunded": 1,
    "ticketsIssued": 4,
}


def at(hour: int, minute: int = 0, second: int = 0) -> datetime:
    return DAY + timedelta(hours=hour, minutes=minute, seconds=second)


@dataclass(frozen=True)
class Raw:
    """Mensagem montada à mão, fora das fábricas (ruído e mensagens inválidas)."""

    topic: str
    key: str
    value: bytes


@dataclass
class Scenario:
    show_a: ShowSpec
    show_b: ShowSpec
    pista: SectorSpec
    plateia: SectorSpec
    lot1: LotSpec
    lot2: LotSpec
    lot_plateia: LotSpec
    orders: dict[str, OrderSpec]
    # Eventos válidos, na ordem de publicação.
    messages: list[Message]
    # Repetições (mesmo eventId) de mensagens já publicadas.
    repeats: list[Message] = field(default_factory=list)
    # Ignoradas (tipo desconhecido ou que o analytics não usa) e inválidas (vão para a DLT).
    ignored: list[Message | Raw] = field(default_factory=list)
    invalid: list[Raw] = field(default_factory=list)
    new_title: str = "Vinte Anos de Estrada (sessão extra)"

    def all_in_publish_order(self) -> list[Message | Raw]:
        """Tudo, com o ruído no meio, como chegaria de verdade."""
        result: list[Message | Raw] = []
        noise: list[Message | Raw] = [*self.repeats, *self.ignored, *self.invalid]
        for index, message in enumerate(self.messages):
            result.append(message)
            if index % 3 == 2 and noise:
                result.append(noise.pop(0))
        result.extend(noise)
        return result


def _id() -> str:
    return events.uuid7(datetime.now(UTC) - timedelta(days=30))


def build() -> Scenario:
    lot1 = LotSpec(id=_id(), name="1º lote", price_cents=12000, quantity=5)
    lot2 = LotSpec(id=_id(), name="2º lote", price_cents=15000, quantity=1000)
    lot_plateia = LotSpec(id=_id(), name="Lote único", price_cents=16000, quantity=80)
    pista = SectorSpec(id=_id(), name="Pista", kind="GENERAL_ADMISSION", capacity=2000, lots=(lot1, lot2))
    plateia = SectorSpec(id=_id(), name="Plateia", kind="RESERVED_SEATING", capacity=80, lots=(lot_plateia,))
    show_a = ShowSpec(
        id=_id(),
        producer_id=str(uuid.uuid4()),
        title="Vinte Anos de Estrada",
        artist="Os Tropicais do Asfalto",
        starts_at=DAY + timedelta(days=20, hours=23, minutes=30),
        sectors=(pista, plateia),
    )
    lot_b = LotSpec(id=_id(), name="Lote único", price_cents=9000, quantity=500)
    pista_b = SectorSpec(id=_id(), name="Pista", kind="GENERAL_ADMISSION", capacity=500, lots=(lot_b,))
    show_b = ShowSpec(
        id=_id(),
        producer_id=str(uuid.uuid4()),
        title="Samba de Quinta",
        artist="Roda do Largo",
        starts_at=DAY + timedelta(days=10, hours=22),
        sectors=(pista_b,),
        service_fee_paid_by="PRODUCER",
    )

    o1 = events.order(show_a, plateia, lot_plateia, ("A-5", "A-6"), at(18, 0))
    o2 = events.order(show_a, pista, lot1, (None, None, None), at(18, 10))
    o3 = events.order(show_a, pista, lot1, (None, None), at(18, 20))
    o4 = events.order(show_a, pista, lot1, (None,), at(19, 5))
    o5 = events.order(
        show_a, pista, lot2, (None, None, None, None), at(19, 30), coupon=Coupon("PISTA50", amount_cents=5000)
    )
    o7 = events.order(show_a, plateia, lot_plateia, ("B-1",), at(18, 40), coupon=Coupon("LANCAMENTO10", percent=10))
    o6 = events.order(show_b, pista_b, lot_b, (None, None), at(18, 30))
    o8 = events.order(show_b, pista_b, lot_b, (None, None, None), at(19), coupon=Coupon("SAMBA15", percent=15))
    o9 = events.order(show_b, pista_b, lot_b, (None,), at(19, 10))
    o10 = events.order(show_b, pista_b, lot_b, (None,), at(19, 20))

    o1_confirmed = o1.confirmed(at(18, 0, 2))
    o2_created = o2.created(at(18, 10))
    messages = [
        # O pedido do show B chega antes do show.
        o6.created(at(18, 30)),
        o6.confirmed(at(18, 30, 4)),
        events.show_event(show_a, version=1, status="PUBLISHED", at=at(15), event_type="ShowPublished"),
        events.show_event(show_a, version=2, status="ON_SALE", at=at(15, 0, 1)),
        events.lot_opened(show_a, pista, lot1, at(15, 0, 1)),
        events.lot_opened(show_a, plateia, lot_plateia, at(15, 0, 1)),
        o1.created(at(18, 0)),
        o1_confirmed,
        o1.tickets_issued(at(18, 0, 3)),
        o2_created,
        o2.confirmed(at(18, 11)),
        o2.tickets_issued(at(18, 11, 30)),
        o3.created(at(18, 20)),
        o3.cancelled(at(18, 20, 5), "PAYMENT_DECLINED"),
        o7.created(at(18, 40)),
        o7.confirmed(at(18, 40, 3)),
        o7.tickets_issued(at(18, 40, 4)),
        o4.created(at(19, 5)),
        o4.cancelled(at(19, 15), "RESERVATION_EXPIRED"),
        events.lot_sold_out(show_a, pista, lot1, at(19, 20)),
        events.lot_opened(show_a, pista, lot2, at(19, 20)),
        o5.created(at(19, 30)),
        o5.confirmed(at(19, 31)),
        events.show_event(show_b, version=1, status="ON_SALE", at=at(18, 50), event_type="ShowPublished"),
        o8.created(at(19)),
        o8.confirmed(at(19, 0, 5)),
        o8.tickets_issued(at(19, 0, 6)),
        o9.created(at(19, 10)),
        o9.confirmed(at(19, 10, 4)),
        o9.tickets_issued(at(19, 10, 5)),
        o10.created(at(19, 20)),
        o10.cancelled(at(19, 20, 5), "PAYMENT_DECLINED"),
        # O comprador do o7 cancela: ingressos cancelados, estorno concluído.
        o7.tickets_cancelled(at(19, 50)),
        o7.refunded(at(19, 52)),
        # O estorno do o9 falha 5 vezes; o produtor reprocessa e ele conclui.
        o9.tickets_cancelled(at(20)),
        o9.refund_failed(at(20, 30)),
        o9.refunded(at(21)),
        events.show_event(show_a, version=3, status="ON_SALE", at=at(20), title="Vinte Anos de Estrada (sessão extra)"),
        # Versão antiga republicada (outro eventId): a mais alta continua valendo.
        events.show_event(show_a, version=2, status="ON_SALE", at=at(20, 5)),
        # Portaria: duas entradas no portão A e uma no B.
        o1.checked_in(0, "Portão A", at(22, 1)),
        o1.checked_in(1, "Portão B", at(22, 2)),
        o2.checked_in(0, "Portão A", at(22, 3)),
    ]

    unknown = {
        "eventId": events.uuid7(at(18, 40)),
        "type": "ShowRated",
        "version": 1,
        "occurredAt": events.iso(at(18, 40)),
        "payload": {"showId": show_a.id, "stars": 5},
    }
    broken_payload = dict(o5.confirmed(at(19, 31)).value)
    broken_payload["eventId"] = events.uuid7(at(19, 31))
    broken_payload["payload"] = {key: value for key, value in broken_payload["payload"].items() if key != "items"}

    return Scenario(
        show_a=show_a,
        show_b=show_b,
        pista=pista,
        plateia=plateia,
        lot1=lot1,
        lot2=lot2,
        lot_plateia=lot_plateia,
        orders={
            "o1": o1,
            "o2": o2,
            "o3": o3,
            "o4": o4,
            "o5": o5,
            "o6": o6,
            "o7": o7,
            "o8": o8,
            "o9": o9,
            "o10": o10,
        },
        messages=messages,
        repeats=[o1_confirmed, o2_created],
        ignored=[
            events.reservation_confirmed(show_a, o1, at(18, 0, 2)),
            events.reservation_returned(show_a, o7, at(19, 53)),
            events.checkin_rejected(show_a, "Portão B", at(22, 4)),
            Raw("shows.catalog", show_a.id, json.dumps(unknown).encode()),
        ],
        invalid=[
            Raw("order.events", o5.id, b"{isto nao e json"),
            Raw("order.events", o5.id, json.dumps(broken_payload).encode()),
        ],
    )

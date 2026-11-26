"""Uma noite de vendas realista, com IDs novos a cada chamada.

Dois shows de produtores diferentes. No show A: pedidos confirmados nos dois
setores, um pagamento recusado, uma reserva expirada, virada de lote por
esgotamento, título alterado depois das vendas e uma versão antiga do show
republicada. No show B, o pedido chega antes do show. Mais o ruído de um
consumidor real: repetições, tipos que o analytics ignora e mensagens fora do
contrato.
"""

import json
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from tests import events
from tests.events import LotSpec, Message, OrderSpec, SectorSpec, ShowSpec

DAY = datetime(2026, 11, 26, tzinfo=UTC)


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
    )

    o1 = events.order(show_a, plateia, lot_plateia, ("A-5", "A-6"), at(18, 0))
    o2 = events.order(show_a, pista, lot1, (None, None, None), at(18, 10))
    o3 = events.order(show_a, pista, lot1, (None, None), at(18, 20))
    o4 = events.order(show_a, pista, lot1, (None,), at(19, 5))
    o5 = events.order(show_a, pista, lot2, (None, None, None, None), at(19, 30))
    o6 = events.order(show_b, pista_b, lot_b, (None, None), at(18, 30))

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
        o4.created(at(19, 5)),
        o4.cancelled(at(19, 15), "RESERVATION_EXPIRED"),
        events.lot_sold_out(show_a, pista, lot1, at(19, 20)),
        events.lot_opened(show_a, pista, lot2, at(19, 20)),
        o5.created(at(19, 30)),
        o5.confirmed(at(19, 31)),
        events.show_event(show_b, version=1, status="ON_SALE", at=at(19, 40), event_type="ShowPublished"),
        events.show_event(show_a, version=3, status="ON_SALE", at=at(20), title="Vinte Anos de Estrada (sessão extra)"),
        # Versão antiga republicada (outro eventId): a mais alta continua valendo.
        events.show_event(show_a, version=2, status="ON_SALE", at=at(20, 5)),
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
        orders={"o1": o1, "o2": o2, "o3": o3, "o4": o4, "o5": o5, "o6": o6},
        messages=messages,
        repeats=[o1_confirmed, o2_created],
        ignored=[
            events.reservation_confirmed(show_a, o1, at(18, 0, 2)),
            Raw("shows.catalog", show_a.id, json.dumps(unknown).encode()),
        ],
        invalid=[
            Raw("order.events", o5.id, b"{isto nao e json"),
            Raw("order.events", o5.id, json.dumps(broken_payload).encode()),
        ],
    )

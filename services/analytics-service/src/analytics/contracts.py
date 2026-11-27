"""Leitura das mensagens do Kafka, conforme `contracts/` na raiz do repositório.

O envelope é lido primeiro; o payload só é validado quando o par (tipo, versão)
é conhecido. Tipo desconhecido é ignorado (o produtor pode começar a publicar um
tipo novo antes de todos os consumidores o tratarem) e campo novo no payload
também, porque campo novo opcional não muda a versão do contrato.
"""

import json
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
)
from pydantic.alias_generators import to_camel

TOPIC_CATALOG = "shows.catalog"
TOPIC_ORDERS = "order.events"
TOPIC_INVENTORY = "inventory.events"
TOPIC_CHECKIN = "checkin.events"
# Os tópicos que o consumidor ao vivo lê, e o replay também: o replay só
# reconstrói o que o consumidor ao vivo montou se ler exatamente os mesmos.
TOPICS: tuple[str, ...] = (TOPIC_CATALOG, TOPIC_ORDERS, TOPIC_INVENTORY, TOPIC_CHECKIN)

Uuid = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
]
NonEmpty = Annotated[str, StringConstraints(min_length=1)]
Cents = Annotated[int, Field(ge=0, strict=True)]


def _to_utc(value: datetime) -> datetime:
    # O MongoDB guarda milissegundos; truncar aqui deixa o que foi lido igual
    # ao que volta do banco.
    utc = value.astimezone(UTC)
    return utc.replace(microsecond=utc.microsecond // 1000 * 1000)


UtcDatetime = Annotated[AwareDatetime, AfterValidator(_to_utc)]


class ContractModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        frozen=True,
        extra="ignore",
    )


class Envelope(ContractModel):
    event_id: Uuid
    type: NonEmpty
    version: int = Field(ge=1, strict=True)
    occurred_at: UtcDatetime
    payload: dict[str, Any]


# --------------------------------------------------------------- shows.catalog


class Venue(ContractModel):
    id: Uuid
    name: NonEmpty
    city: NonEmpty
    state: NonEmpty
    timezone: NonEmpty


class Lot(ContractModel):
    id: Uuid
    name: NonEmpty
    price_cents: Cents
    quantity: int = Field(ge=1)
    opens_at: UtcDatetime | None


class Sector(ContractModel):
    id: Uuid
    name: NonEmpty
    kind: Literal["GENERAL_ADMISSION", "RESERVED_SEATING"]
    capacity: int = Field(ge=1)
    lots: list[Lot] = Field(min_length=1)


ShowStatus = Literal["PUBLISHED", "ON_SALE", "SALES_CLOSED", "FINISHED", "CANCELLED"]
# Quem paga a taxa de serviço de 10%: o comprador (somada ao total) ou o
# produtor (sai do valor a receber dele).
FeePaidBy = Literal["BUYER", "PRODUCER"]


class ShowSnapshot(ContractModel):
    """`ShowPublished` e `ShowUpdated` v1: o show inteiro, com `version` que só cresce."""

    show_id: Uuid
    version: int = Field(ge=1)
    producer_id: NonEmpty
    status: ShowStatus
    title: NonEmpty
    artist: NonEmpty
    starts_at: UtcDatetime
    doors_open_at: UtcDatetime | None
    sales_start_at: UtcDatetime | None
    sales_end_at: UtcDatetime | None
    high_demand: bool
    venue: Venue
    sectors: list[Sector] = Field(min_length=1)
    updated_at: UtcDatetime
    # Fase 6. Shows publicados antes dela não têm o campo: o comprador pagava.
    service_fee_paid_by: FeePaidBy = "BUYER"


# ---------------------------------------------------------------- order.events


class OrderItem(ContractModel):
    sector_id: Uuid
    sector_name: NonEmpty
    lot_id: Uuid
    lot_name: NonEmpty
    seat: str | None
    unit_price_cents: Cents


class Pricing(ContractModel):
    """Valores do pedido da fase 6: subtotal, desconto do cupom e taxa de serviço.

    Os eventos publicados antes da fase 6 não têm esses campos, e o replay lê o
    `order.events` desde o começo. Para eles valem os padrões: sem cupom, sem
    taxa, e o subtotal é o total (era assim que o pedido era cobrado).
    """

    total_cents: Cents
    subtotal_cents: Cents | None = None
    discount_cents: Cents = 0
    service_fee_cents: Cents = 0
    service_fee_paid_by: FeePaidBy = "BUYER"
    coupon_id: Uuid | None = None
    coupon_code: str | None = None

    @property
    def subtotal(self) -> int:
        return self.subtotal_cents if self.subtotal_cents is not None else self.total_cents


class OrderCreated(Pricing):
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    reservation_id: Uuid
    items: list[OrderItem] = Field(min_length=1)
    created_at: UtcDatetime


class OrderConfirmed(Pricing):
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    reservation_id: Uuid
    items: list[OrderItem] = Field(min_length=1)
    confirmed_at: UtcDatetime


class OrderCancelled(ContractModel):
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    reservation_id: Uuid
    total_cents: Cents
    # PAYMENT_DECLINED ou RESERVATION_EXPIRED. Lido como texto: um motivo novo
    # não deve mandar o cancelamento para a DLT.
    reason: NonEmpty
    cancelled_at: UtcDatetime


class IssuedTicket(ContractModel):
    ticket_id: Uuid
    sector_id: Uuid
    sector_name: NonEmpty
    seat: str | None


class TicketsIssued(ContractModel):
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    tickets: list[IssuedTicket] = Field(min_length=1)
    issued_at: UtcDatetime


class TicketsCancelled(ContractModel):
    """Os ingressos foram cancelados: o pedido entra em reembolso (`REFUNDING`)."""

    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    ticket_ids: list[Uuid] = Field(min_length=1)
    # Lido como texto, como o motivo do OrderCancelled.
    reason: NonEmpty
    cancelled_at: UtcDatetime


class OrderRefunded(Pricing):
    """Estorno concluído. `refunded_cents` é o que o comprador recebeu de volta (o total pago)."""

    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    reservation_id: Uuid
    refunded_cents: Cents
    reason: NonEmpty
    refunded_at: UtcDatetime
    # O OrderRefunded não traz `totalCents`: o que o comprador pagou é o `refundedCents`.
    total_cents: Cents = 0


class OrderRefundFailed(ContractModel):
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    attempts: int = Field(ge=1)
    failed_at: UtcDatetime


OrderEvent = (
    OrderCreated
    | OrderConfirmed
    | OrderCancelled
    | TicketsIssued
    | TicketsCancelled
    | OrderRefunded
    | OrderRefundFailed
)

# ------------------------------------------------------------ inventory.events


class LotOpened(ContractModel):
    show_id: Uuid
    sector_id: Uuid
    lot_id: Uuid
    price_cents: Cents
    available: int = Field(ge=0)
    opened_at: UtcDatetime


class LotSoldOut(ContractModel):
    show_id: Uuid
    sector_id: Uuid
    lot_id: Uuid
    sold_out_at: UtcDatetime


# -------------------------------------------------------------- checkin.events


class TicketCheckedIn(ContractModel):
    """Entrada registrada na portaria. A chave do tópico é o `showId`, não o pedido."""

    ticket_id: Uuid
    show_id: Uuid
    order_id: Uuid
    sector_id: Uuid
    sector_name: NonEmpty
    seat: str | None
    gate: NonEmpty
    checked_in_at: UtcDatetime


Payload = ShowSnapshot | OrderEvent | LotOpened | LotSoldOut | TicketCheckedIn

# (tipo, versão) -> modelo do payload. Só o que muda um read model está aqui.
PAYLOADS: dict[tuple[str, int], type[ContractModel]] = {
    ("ShowPublished", 1): ShowSnapshot,
    ("ShowUpdated", 1): ShowSnapshot,
    ("OrderCreated", 1): OrderCreated,
    ("OrderConfirmed", 1): OrderConfirmed,
    ("OrderCancelled", 1): OrderCancelled,
    ("TicketsIssued", 1): TicketsIssued,
    ("TicketsCancelled", 1): TicketsCancelled,
    ("OrderRefunded", 1): OrderRefunded,
    ("OrderRefundFailed", 1): OrderRefundFailed,
    ("LotOpened", 1): LotOpened,
    ("LotSoldOut", 1): LotSoldOut,
    ("TicketCheckedIn", 1): TicketCheckedIn,
}

# Tipos conhecidos que, de propósito, não alimentam read model: a reserva
# confirmada, liberada ou devolvida já aparece no pedido (OrderConfirmed,
# OrderCancelled, OrderRefunded), e a leitura recusada na portaria não muda
# ingresso nenhum.
DELIBERATELY_IGNORED = frozenset(
    {"ReservationConfirmed", "ReservationReleased", "ReservationReturned", "CheckinRejected"}
)


class ContractError(Exception):
    """A mensagem não segue o contrato. Repetir não muda o resultado: vai para a DLT."""


@dataclass(frozen=True, slots=True)
class Event:
    """Mensagem lida e validada, pronta para as projeções."""

    envelope: Envelope
    payload: Payload

    @property
    def event_id(self) -> str:
        return self.envelope.event_id

    @property
    def type(self) -> str:
        return self.envelope.type


def parse(value: bytes | None) -> Event | None:
    """Lê uma mensagem. Devolve `None` para tipo ou versão que este serviço ignora.

    Levanta `ContractError` para mensagem que não é JSON, não tem envelope
    válido ou tem payload fora do contrato de um tipo conhecido.
    """
    if value is None:
        raise ContractError("mensagem sem valor")
    try:
        raw = json.loads(value)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractError(f"mensagem não é JSON válido: {error}") from error
    try:
        envelope = Envelope.model_validate(raw)
    except ValidationError as error:
        raise ContractError(f"envelope inválido: {_summary(error)}") from error

    model = PAYLOADS.get((envelope.type, envelope.version))
    if model is None:
        return None
    try:
        payload = model.model_validate(envelope.payload)
    except ValidationError as error:
        raise ContractError(f"payload de {envelope.type} v{envelope.version} inválido: {_summary(error)}") from error
    return Event(envelope=envelope, payload=payload)  # type: ignore[arg-type]


def _summary(error: ValidationError) -> str:
    parts = [f"{'.'.join(str(p) for p in e['loc']) or '(raiz)'}: {e['msg']}" for e in error.errors()[:5]]
    return "; ".join(parts)

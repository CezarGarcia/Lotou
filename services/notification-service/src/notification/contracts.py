"""Leitura das mensagens de `order.events`, conforme `contracts/` na raiz do repositório.

O envelope é lido primeiro; o payload só é validado quando o par (tipo, versão)
interessa a este serviço. Tipo desconhecido é ignorado (o produtor pode começar
a publicar um tipo novo antes de todos os consumidores o tratarem) e campo novo
no payload também, porque campo novo opcional não muda a versão do contrato.
"""

import json
from dataclasses import dataclass
from datetime import UTC
from typing import Annotated, Any

from pydantic import AfterValidator, AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from pydantic.alias_generators import to_camel

TOPIC_ORDERS = "order.events"

Uuid = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
]
NonEmpty = Annotated[str, StringConstraints(min_length=1)]
Cents = Annotated[int, Field(ge=0, strict=True)]
UtcDatetime = Annotated[AwareDatetime, AfterValidator(lambda value: value.astimezone(UTC))]
# LOTOU1.<ticketId>.<HMAC em base64url>: o order-service assina, aqui só vira QR code.
TicketCode = Annotated[str, StringConstraints(pattern=r"^LOTOU1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$")]


class ContractModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True, extra="ignore")


class Envelope(ContractModel):
    event_id: Uuid
    type: NonEmpty
    version: int = Field(ge=1, strict=True)
    occurred_at: UtcDatetime
    payload: dict[str, Any]


class IssuedTicket(ContractModel):
    ticket_id: Uuid
    sector_id: Uuid
    sector_name: NonEmpty
    seat: str | None
    code: TicketCode


class TicketsIssued(ContractModel):
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    tickets: list[IssuedTicket] = Field(min_length=1)
    issued_at: UtcDatetime


class OrderCancelled(ContractModel):
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    total_cents: Cents
    # Lido como texto: um motivo novo não deve mandar o cancelamento para a DLT;
    # o e-mail usa um texto genérico para o que não conhece.
    reason: NonEmpty
    cancelled_at: UtcDatetime


class OrderRefunded(ContractModel):
    """Estorno concluído. Só o que o e-mail usa; o resto do payload é ignorado."""

    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    # O que voltou ao comprador: o total pago, taxa incluída.
    refunded_cents: Cents
    # ORDER_CANCELLED ou SHOW_CANCELLED. Lido como texto, como no cancelamento.
    reason: NonEmpty
    refunded_at: UtcDatetime


Payload = TicketsIssued | OrderCancelled | OrderRefunded

# (tipo, versão) -> modelo do payload. Só o que vira notificação está aqui.
PAYLOADS: dict[tuple[str, int], type[ContractModel]] = {
    ("TicketsIssued", 1): TicketsIssued,
    ("OrderCancelled", 1): OrderCancelled,
    ("OrderRefunded", 1): OrderRefunded,
}


class ContractError(Exception):
    """A mensagem não segue o contrato. Repetir não muda o resultado: vai para a DLT."""


@dataclass(frozen=True, slots=True)
class Event:
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
    válido ou tem payload fora do contrato de um tipo que interessa aqui.
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
        raise ContractError(f"envelope inválido: {summary(error)}") from error

    model = PAYLOADS.get((envelope.type, envelope.version))
    if model is None:
        return None
    try:
        payload = model.model_validate(envelope.payload)
    except ValidationError as error:
        raise ContractError(f"payload de {envelope.type} v{envelope.version} inválido: {summary(error)}") from error
    return Event(envelope=envelope, payload=payload)  # type: ignore[arg-type]


def peek_type(value: bytes | None) -> str:
    """O `type` do envelope, só para métricas e logs de mensagem que não será tratada."""
    try:
        raw = json.loads(value or b"")
    except ValueError:
        return "unknown"
    event_type = raw.get("type") if isinstance(raw, dict) else None
    return event_type if isinstance(event_type, str) else "unknown"


def summary(error: ValidationError) -> str:
    parts = [f"{'.'.join(str(p) for p in e['loc']) or '(raiz)'}: {e['msg']}" for e in error.errors()[:5]]
    return "; ".join(parts)

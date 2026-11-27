"""Tarefas que passam pelo RabbitMQ.

São mensagens internas do serviço: quem publica e quem consome é o próprio
notification-service (o consumidor do Kafka, o worker de PDF e o de e-mail), por
isso não ficam em `contracts/`, que guarda o que passa entre serviços pelo Kafka.
Seguem a mesma convenção: comandos no imperativo (`RenderTickets`, `SendEmail`,
`GenerateStatement`),
envelope versionado (`messageId` em UUID v7, `type`, `version`, `createdAt`,
`payload`) e JSON em UTF-8. CPF e e-mail não entram em tarefa nenhuma: o worker
de e-mail resolve o endereço pelo `buyerId` na hora de enviar.

Cada tarefa leva o `sourceEventId`, o `eventId` do Kafka que a originou, que é
a chave de deduplicação até o fim: duas tarefas do mesmo evento mandam um
e-mail só.
"""

import base64
import json
from datetime import UTC, datetime
from typing import Annotated, Any, Final, Literal

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

from notification.contracts import Cents, NonEmpty, TicketCode, Uuid, summary
from notification.ids import utcnow, uuid7

UtcDatetime = Annotated[AwareDatetime, AfterValidator(lambda value: value.astimezone(UTC))]

TEMPLATE_TICKETS: Final = "email.ticket.issued"
TEMPLATE_CANCELLED: Final = "email.order.cancelled"
TEMPLATE_REFUNDED: Final = "email.refund.completed"
TEMPLATE_STATEMENT: Final = "email.report.statement"

# Fila `notifications.email` com `x-max-priority` 10: o ingresso passa na frente
# do resto quando a fila acumula (ingresso antes de marketing, no documento).
MAX_PRIORITY = 10
PRIORITIES: dict[str, int] = {
    TEMPLATE_TICKETS: 9,
    TEMPLATE_CANCELLED: 5,
    TEMPLATE_REFUNDED: 5,
    TEMPLATE_STATEMENT: 5,
}


class TaskModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True, extra="ignore")


# ------------------------------------------------------------ RenderTickets


class TicketToRender(TaskModel):
    ticket_id: Uuid
    sector_name: NonEmpty
    seat: str | None
    code: TicketCode


class RenderTickets(TaskModel):
    """Gerar o PDF de um pedido: uma página por ingresso."""

    source_event_id: Uuid
    order_id: Uuid
    buyer_id: NonEmpty
    show_id: Uuid
    issued_at: UtcDatetime
    tickets: list[TicketToRender] = Field(min_length=1)


# ---------------------------------------------------------------- SendEmail


class ShowInfo(TaskModel):
    """O que o e-mail e o PDF mostram do show, como o event-service devolveu."""

    title: NonEmpty
    artist: NonEmpty
    starts_at: UtcDatetime
    # Fuso IANA do local: as datas são exibidas nele, não no do servidor.
    timezone: NonEmpty
    venue_name: str | None = None
    venue_city: str | None = None
    venue_state: str | None = None


class Attachment(TaskModel):
    filename: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._-]{1,100}$")]
    content_type: NonEmpty
    content_base64: NonEmpty

    def content(self) -> bytes:
        return base64.b64decode(self.content_base64, validate=True)

    @classmethod
    def pdf(cls, filename: str, content: bytes) -> "Attachment":
        return cls(
            filename=filename,
            content_type="application/pdf",
            content_base64=base64.b64encode(content).decode("ascii"),
        )


class TicketsEmail(TaskModel):
    template: Literal["email.ticket.issued"] = TEMPLATE_TICKETS
    source_event_id: Uuid
    buyer_id: NonEmpty
    order_id: Uuid
    show_id: Uuid
    show: ShowInfo
    ticket_count: int = Field(ge=1)
    attachment: Attachment


class CancellationEmail(TaskModel):
    template: Literal["email.order.cancelled"] = TEMPLATE_CANCELLED
    source_event_id: Uuid
    buyer_id: NonEmpty
    order_id: Uuid
    show_id: Uuid
    total_cents: Cents
    reason: NonEmpty
    cancelled_at: UtcDatetime


class RefundEmail(TaskModel):
    template: Literal["email.refund.completed"] = TEMPLATE_REFUNDED
    source_event_id: Uuid
    buyer_id: NonEmpty
    order_id: Uuid
    show_id: Uuid
    refunded_cents: Cents
    reason: NonEmpty
    refunded_at: UtcDatetime


class StatementEmail(TaskModel):
    """O relatório financeiro em PDF para o produtor. `source_event_id` é o id do pedido de relatório."""

    template: Literal["email.report.statement"] = TEMPLATE_STATEMENT
    source_event_id: Uuid
    # O produtor também é um usuário do Keycloak: o endereço vem do mesmo lugar que o do comprador.
    producer_id: NonEmpty
    show_id: Uuid
    title: NonEmpty
    partial: bool
    receivable_cents: int
    attachment: Attachment


type Email = TicketsEmail | CancellationEmail | RefundEmail | StatementEmail


def recipient_id(email: Email) -> str:
    """O `sub` de quem recebe: o comprador, ou o produtor no relatório."""
    return email.producer_id if isinstance(email, StatementEmail) else email.buyer_id


def reference(email: Email) -> str:
    """O que identifica o e-mail em log e span: o pedido, ou o pedido de relatório."""
    return email.source_event_id if isinstance(email, StatementEmail) else email.order_id


EmailPayload = Annotated[Email, Field(discriminator="template")]


class SendEmail(TaskModel):
    email: EmailPayload


# --------------------------------------------------------- GenerateStatement


class StatementData(TaskModel):
    """O relatório do analytics (`GET /internal/v1/shows/{id}/statement`) no momento do pedido."""

    show_id: Uuid
    producer_id: NonEmpty
    title: NonEmpty
    artist: NonEmpty
    starts_at: UtcDatetime
    timezone: NonEmpty
    venue_name: NonEmpty
    status: NonEmpty
    partial: bool
    currency: NonEmpty
    gross_sales_cents: int
    discounts_cents: int
    refunds_cents: int
    platform_fee_cents: int
    buyer_fees_cents: int
    receivable_cents: int
    confirmed_orders: int
    refunded_orders: int
    tickets_sold: int
    tickets_refunded: int


class GenerateStatement(TaskModel):
    """Gerar o PDF do relatório financeiro e enviá-lo ao produtor que pediu."""

    request_id: Uuid
    producer_id: NonEmpty
    requested_at: UtcDatetime
    statement: StatementData


# ----------------------------------------------------------------- envelope

TaskPayload = RenderTickets | SendEmail | GenerateStatement
TASK_TYPES: dict[tuple[str, int], type[TaskModel]] = {
    ("RenderTickets", 1): RenderTickets,
    ("SendEmail", 1): SendEmail,
    ("GenerateStatement", 1): GenerateStatement,
}
_TYPE_NAMES: dict[type[TaskModel], str] = {
    RenderTickets: "RenderTickets",
    SendEmail: "SendEmail",
    GenerateStatement: "GenerateStatement",
}


class TaskEnvelope(TaskModel):
    message_id: Uuid
    type: NonEmpty
    version: int = Field(ge=1, strict=True)
    created_at: UtcDatetime
    payload: dict[str, Any]


class InvalidTask(Exception):
    """A tarefa não pode ser lida. Repetir não muda nada: vai direto para a DLQ."""


def encode(payload: TaskPayload, *, message_id: str | None = None, created_at: datetime | None = None) -> bytes:
    body = {
        "messageId": message_id or uuid7(),
        "type": _TYPE_NAMES[type(payload)],
        "version": 1,
        "createdAt": (created_at or utcnow()).isoformat().replace("+00:00", "Z"),
        "payload": payload.model_dump(mode="json", by_alias=True),
    }
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()


def decode[T: TaskModel](body: bytes, expected: type[T]) -> tuple[TaskEnvelope, T]:
    """Lê a tarefa e confere que é do tipo que a fila espera."""
    try:
        envelope = TaskEnvelope.model_validate_json(body)
    except ValidationError as error:
        raise InvalidTask(f"envelope inválido: {summary(error)}") from error
    model = TASK_TYPES.get((envelope.type, envelope.version))
    if model is not expected:
        raise InvalidTask(f"tarefa {envelope.type} v{envelope.version} não é tratada nesta fila")
    try:
        return envelope, expected.model_validate(envelope.payload)
    except ValidationError as error:
        raise InvalidTask(f"payload de {envelope.type} inválido: {summary(error)}") from error


def routing_key(email: Email) -> str:
    """A routing key no exchange `notifications` é o próprio template."""
    return email.template


def priority(email: Email) -> int:
    return PRIORITIES.get(email.template, 1)

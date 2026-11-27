"""O consumidor lê os exemplos de `contracts/examples/order.events` e as tarefas do RabbitMQ."""

import json
from pathlib import Path

import pytest

from notification import tasks
from notification.contracts import ContractError, OrderCancelled, OrderRefunded, TicketsIssued, parse, peek_type
from notification.ids import uuid7
from tests.events import (
    CONTRACTS,
    order_cancelled,
    order_created,
    order_refunded,
    ticket_code,
    tickets_issued,
    validator,
)

EXAMPLES = sorted((CONTRACTS / "examples" / "order.events").glob("*.json"))
HANDLED = {"TicketsIssued": TicketsIssued, "OrderCancelled": OrderCancelled, "OrderRefunded": OrderRefunded}


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda path: path.name)
def test_contract_example_is_read(path: Path) -> None:
    raw = json.loads(path.read_text(encoding="utf-8"))
    validator(raw["type"], raw["version"]).validate(raw)

    event = parse(path.read_bytes())

    if raw["type"] not in HANDLED:
        assert event is None
        return
    assert event is not None
    assert isinstance(event.payload, HANDLED[raw["type"]])
    assert event.event_id == raw["eventId"]


def test_handled_types_have_examples() -> None:
    types = {json.loads(path.read_text(encoding="utf-8"))["type"] for path in EXAMPLES}
    assert set(HANDLED) <= types


def test_tickets_issued_carries_the_qr_code() -> None:
    message = tickets_issued(buyer_id="comprador-1", show_id=uuid7(), seats=["A-1", None])

    event = parse(message.raw())

    assert event is not None
    assert isinstance(event.payload, TicketsIssued)
    assert [t.code for t in event.payload.tickets] == [t["code"] for t in message.payload["tickets"]]
    assert [t.seat for t in event.payload.tickets] == ["A-1", None]


def test_order_refunded_carries_the_amount_paid_back() -> None:
    message = order_refunded(buyer_id="comprador-1", show_id=uuid7(), reason="SHOW_CANCELLED")
    event = parse(message.raw())
    assert event is not None
    assert isinstance(event.payload, OrderRefunded)
    # 320,00 - 32,00 de cupom + 32,00 de taxa: o comprador recebe o que pagou.
    assert (event.payload.refunded_cents, event.payload.reason) == (32000, "SHOW_CANCELLED")


def test_other_types_and_versions_are_ignored() -> None:
    assert parse(order_created(buyer_id="comprador-1", show_id=uuid7()).raw()) is None
    message = order_cancelled(buyer_id="comprador-1", show_id=uuid7())
    assert parse(json.dumps({**message.value, "version": 2}).encode()) is None


def test_unknown_cancellation_reason_is_accepted() -> None:
    message = order_cancelled(buyer_id="comprador-1", show_id=uuid7())
    value = {**message.value, "payload": {**message.payload, "reason": "MOTIVO_NOVO"}}

    event = parse(json.dumps(value).encode())

    assert event is not None
    assert isinstance(event.payload, OrderCancelled)
    assert event.payload.reason == "MOTIVO_NOVO"


@pytest.mark.parametrize(
    "value",
    [
        None,
        b"nao e json",
        b'{"type": "TicketsIssued"}',
        b'{"eventId": "x", "type": "TicketsIssued", "version": 1, "occurredAt": "2026-11-26T18:00:00Z", "payload": {}}',
    ],
)
def test_out_of_contract_is_an_error(value: bytes | None) -> None:
    with pytest.raises(ContractError):
        parse(value)


def test_ticket_code_outside_the_format_is_an_error() -> None:
    message = tickets_issued(buyer_id="comprador-1", show_id=uuid7(), seats=["A-1"])
    tickets = [{**message.payload["tickets"][0], "code": "qualquer-coisa"}]
    value = {**message.value, "payload": {**message.payload, "tickets": tickets}}

    with pytest.raises(ContractError, match="code"):
        parse(json.dumps(value).encode())


def test_peek_type() -> None:
    assert peek_type(b'{"type": "OrderCreated"}') == "OrderCreated"
    assert peek_type(b"[1]") == "unknown"
    assert peek_type(b"\xff") == "unknown"


# ------------------------------------------------------------------ tarefas


def test_task_round_trip() -> None:
    email = tasks.CancellationEmail(
        source_event_id=uuid7(),
        buyer_id="comprador-1",
        order_id=uuid7(),
        show_id=uuid7(),
        total_cents=32000,
        reason="PAYMENT_DECLINED",
        cancelled_at="2026-11-26T18:00:02Z",  # type: ignore[arg-type]
    )
    body = tasks.encode(tasks.SendEmail(email=email), message_id=uuid7())

    envelope, decoded = tasks.decode(body, tasks.SendEmail)

    assert envelope.type == "SendEmail"
    assert envelope.version == 1
    assert decoded.email == email
    assert tasks.routing_key(decoded.email) == "email.order.cancelled"
    assert tasks.priority(decoded.email) < tasks.PRIORITIES[tasks.TEMPLATE_TICKETS] <= tasks.MAX_PRIORITY
    # Nada de e-mail na tarefa: só o buyerId.
    assert b"@" not in body


def test_refund_and_statement_tasks_round_trip() -> None:
    refund = tasks.RefundEmail(
        source_event_id=uuid7(),
        buyer_id="comprador-1",
        order_id=uuid7(),
        show_id=uuid7(),
        refunded_cents=32000,
        reason="ORDER_CANCELLED",
        refunded_at="2026-11-27T18:05:00Z",  # type: ignore[arg-type]
    )
    _, decoded = tasks.decode(tasks.encode(tasks.SendEmail(email=refund)), tasks.SendEmail)
    assert decoded.email == refund
    assert tasks.routing_key(refund) == "email.refund.completed"
    assert tasks.priority(refund) == 5
    assert (tasks.recipient_id(refund), tasks.reference(refund)) == ("comprador-1", refund.order_id)

    request_id = uuid7()
    statement = tasks.StatementEmail(
        source_event_id=request_id,
        producer_id="produtor-1",
        show_id=uuid7(),
        title="Noite de Teste",
        partial=True,
        receivable_cents=36450,
        attachment=tasks.Attachment.pdf("relatorio.pdf", b"%PDF-1.4 teste"),
    )
    _, decoded = tasks.decode(tasks.encode(tasks.SendEmail(email=statement)), tasks.SendEmail)
    assert decoded.email == statement
    assert tasks.routing_key(statement) == "email.report.statement"
    assert (tasks.recipient_id(statement), tasks.reference(statement)) == ("produtor-1", request_id)


def test_task_of_another_queue_is_invalid() -> None:
    render = tasks.RenderTickets(
        source_event_id=uuid7(),
        order_id=uuid7(),
        buyer_id="comprador-1",
        show_id=uuid7(),
        issued_at="2026-11-26T18:00:02Z",  # type: ignore[arg-type]
        tickets=[tasks.TicketToRender(ticket_id=(t := uuid7()), sector_name="Pista", seat=None, code=ticket_code(t))],
    )
    with pytest.raises(tasks.InvalidTask, match="não é tratada nesta fila"):
        tasks.decode(tasks.encode(render), tasks.SendEmail)
    with pytest.raises(tasks.InvalidTask, match="envelope"):
        tasks.decode(b"{}", tasks.RenderTickets)

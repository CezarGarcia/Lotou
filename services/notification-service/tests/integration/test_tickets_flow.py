"""Do `TicketsIssued` no Kafka ao e-mail com o PDF no Mailpit, sem repetir e-mail."""

import asyncio
import json
from typing import Any

import aio_pika
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
from opentelemetry import propagate, trace

from notification import tasks
from notification.ids import uuid7
from notification.rabbit import topology
from notification.rabbit.publisher import Publisher
from notification.rabbit.retry import ATTEMPT_HEADER
from tests.events import TOPIC, order_cancelled, ticket_code, tickets_issued
from tests.fakes import FakeBackends
from tests.integration.conftest import ALL_QUEUES, Infra, MailpitApi, Telemetry, publish, queue_depth, wait_for
from tests.pdfs import read_pdf


async def test_tickets_issued_becomes_an_email_with_the_pdf(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    mailpit: MailpitApi,
    telemetry: Telemetry,
) -> None:
    show_id = backends.add_show(title="Noite de Teste", artist="Banda Fictícia", timezone="America/Manaus")
    buyer_id = backends.add_buyer(email="bia@lotou.test", first_name="Bia")
    message = tickets_issued(buyer_id=buyer_id, show_id=show_id, seats=["A-5", None])
    order_id = message.payload["orderId"]

    async with run_service():
        # O trace começa no order-service: o relay do outbox publica com `traceparent`.
        with trace.get_tracer("tests").start_as_current_span("order-service outbox relay") as root:
            carrier: dict[str, str] = {}
            propagate.inject(carrier)
        await publish(producer, message, headers=[(key, value.encode()) for key, value in carrier.items()])
        [summary] = await mailpit.wait_for(1)

    detail = await mailpit.message(summary["ID"])
    assert [to["Address"] for to in detail["To"]] == ["bia@lotou.test"]
    assert detail["Subject"] == "Seus ingressos para Noite de Teste"
    assert "Olá, Bia!" in detail["Text"]
    assert "sábado, 12 de dezembro de 2026, às 20h00 (horário de America/Manaus)" in detail["Text"]
    assert order_id in detail["Text"]
    [attachment] = detail["Attachments"]
    assert attachment["FileName"] == f"ingressos-{order_id}.pdf"
    assert attachment["ContentType"] == "application/pdf"

    pages = read_pdf(await mailpit.attachment(summary["ID"], attachment["PartID"]))
    assert [page.qr_codes for page in pages] == [[ticket["code"]] for ticket in message.payload["tickets"]]
    assert "Lugar A-5" in pages[0].text
    assert "Lugar Pista" in pages[1].text

    # Um trace só, do relay do order-service ao SMTP, atravessando Kafka e RabbitMQ.
    trace_id = root.get_span_context().trace_id
    spans = [span for span in telemetry.spans.get_finished_spans() if span.context.trace_id == trace_id]
    names = {span.name for span in spans}
    assert {"order.events process", "ticket render", "smtp send"} <= names
    rabbit_spans = [span for span in spans if (span.attributes or {}).get("messaging.system") == "rabbitmq"]
    assert {span.kind.name for span in rabbit_spans} == {"PRODUCER", "CONSUMER"}
    # E-mail nenhum em span nenhum.
    for span in telemetry.spans.get_finished_spans():
        assert "bia@lotou.test" not in json.dumps(dict(span.attributes or {}), default=str)


async def test_redelivered_event_sends_a_single_email(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    mailpit: MailpitApi,
    telemetry: Telemetry,
) -> None:
    show_id = backends.add_show(title="Noite Repetida")
    buyer_id = backends.add_buyer()
    issued = tickets_issued(buyer_id=buyer_id, show_id=show_id, seats=["C-1"])
    cancelled = order_cancelled(buyer_id=buyer_id, show_id=show_id)
    sentinel = order_cancelled(buyer_id=buyer_id, show_id=show_id, reason="RESERVATION_EXPIRED")
    duplicates_before = telemetry.value("notification_events", result="duplicate")

    async with run_service():
        # Mesma chave: mesma partição, e o Kafka entrega nesta ordem. O relay do
        # outbox publicou cada evento duas vezes (caiu antes de marcar o lote).
        for message in (issued, issued, cancelled, cancelled, sentinel):
            await publish(producer, message, key=issued.key)
        found = await mailpit.wait_for(3)
        await asyncio.sleep(1.5)  # tempo para um e-mail repetido, se houvesse, chegar
        found = await mailpit.messages()

    subjects = sorted(message["Subject"] for message in found)
    assert subjects == [
        "Pedido cancelado: Noite Repetida",
        "Pedido cancelado: Noite Repetida",
        "Seus ingressos para Noite Repetida",
    ]
    assert telemetry.value("notification_events", result="duplicate") - duplicates_before == 2


async def test_same_task_twice_sends_a_single_email(
    run_service: Any,
    backends: FakeBackends,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
    telemetry: Telemetry,
) -> None:
    """O worker de PDF caiu depois de publicar o e-mail e antes do ack: a tarefa sai de novo."""
    show_id = backends.add_show(title="Noite Dupla")
    buyer_id = backends.add_buyer()
    ticket_id = uuid7()
    render = tasks.RenderTickets(
        source_event_id=uuid7(),
        order_id=uuid7(),
        buyer_id=buyer_id,
        show_id=show_id,
        issued_at="2026-11-26T18:00:02Z",  # type: ignore[arg-type]
        tickets=[
            tasks.TicketToRender(ticket_id=ticket_id, sector_name="Pista", seat=None, code=ticket_code(ticket_id))
        ],
    )
    duplicates_before = telemetry.value("emails_sent", result="duplicate")

    async with run_service(components=frozenset({"render", "email"})):
        publisher = Publisher(rabbit)
        for _ in range(2):
            message_id = uuid7()
            body = tasks.encode(render, message_id=message_id)
            await publisher.publish(
                topology.TICKETS, topology.RENDER_KEY, body, message_id=message_id, message_type="RenderTickets"
            )
        await publisher.close()
        await mailpit.wait_for(1)
        await wait_for(lambda: telemetry.value("emails_sent", result="duplicate") - duplicates_before == 1)

    assert len(await mailpit.messages()) == 1


async def test_buyer_without_email_is_acknowledged_without_retry(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
    telemetry: Telemetry,
) -> None:
    """As contas de serviço do smoke e dos testes de carga compram sem ter e-mail."""
    show_id = backends.add_show()
    buyer_id = backends.add_buyer(email=None)
    before = telemetry.value("emails_sent", result="no_recipient", template="email.ticket.issued")

    async with run_service():
        await publish(producer, tickets_issued(buyer_id=buyer_id, show_id=show_id, seats=["D-1"]))
        await wait_for(
            lambda: telemetry.value("emails_sent", result="no_recipient", template="email.ticket.issued") - before == 1
        )
        for queue in ALL_QUEUES:
            assert await queue_depth(rabbit, queue) == 0, queue

    assert await mailpit.messages() == []


async def test_ticket_email_jumps_the_queue(
    run_service: Any,
    backends: FakeBackends,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
) -> None:
    """Com a fila acumulada, o e-mail do ingresso (prioridade 9) sai antes dos outros (5)."""
    show_id = backends.add_show(title="Noite Prioritária")
    buyer_id = backends.add_buyer()
    publisher = Publisher(rabbit)
    emails: list[tasks.TicketsEmail | tasks.CancellationEmail] = [
        tasks.CancellationEmail(
            source_event_id=uuid7(),
            buyer_id=buyer_id,
            order_id=uuid7(),
            show_id=show_id,
            total_cents=1000,
            reason="PAYMENT_DECLINED",
            cancelled_at="2026-11-26T18:00:02Z",  # type: ignore[arg-type]
        )
        for _ in range(3)
    ]
    emails.append(
        tasks.TicketsEmail(
            source_event_id=uuid7(),
            buyer_id=buyer_id,
            order_id=uuid7(),
            show_id=show_id,
            show=tasks.ShowInfo(
                title="Noite Prioritária",
                artist="Banda",
                starts_at="2026-12-13T00:00:00Z",  # type: ignore[arg-type]
                timezone="America/Sao_Paulo",
            ),
            ticket_count=1,
            attachment=tasks.Attachment.pdf("ingressos.pdf", b"%PDF-1.4 teste"),
        )
    )
    for email in emails:
        message_id = uuid7()
        await publisher.publish(
            topology.NOTIFICATIONS,
            tasks.routing_key(email),
            tasks.encode(tasks.SendEmail(email=email), message_id=message_id),
            message_id=message_id,
            message_type="SendEmail",
            headers={ATTEMPT_HEADER: 1},
            priority=tasks.priority(email),
        )
    await publisher.close()

    async with run_service(components=frozenset({"email"}), email_prefetch=1):
        found = await mailpit.wait_for(4)

    # O Mailpit lista do mais novo para o mais antigo.
    assert found[-1]["Subject"] == "Seus ingressos para Noite Prioritária"


async def test_message_out_of_contract_goes_to_the_dlt_and_the_consumer_goes_on(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    mailpit: MailpitApi,
    infra: Infra,
) -> None:
    show_id = backends.add_show(title="Depois do Lixo")
    buyer_id = backends.add_buyer()
    valid = order_cancelled(buyer_id=buyer_id, show_id=show_id)

    async with run_service():
        await publish(producer, b"isto nao e json", key=valid.key)
        await publish(producer, valid)
        [summary] = await mailpit.wait_for(1)
    assert summary["Subject"] == "Pedido cancelado: Depois do Lixo"

    dlt = AIOKafkaConsumer(
        f"{TOPIC}.dlt",
        bootstrap_servers=infra.kafka.bootstrap_servers,
        auto_offset_reset="earliest",
        group_id=f"teste-{uuid7()}",
    )
    await dlt.start()
    try:
        batches = await dlt.getmany(timeout_ms=5000)
    finally:
        await dlt.stop()
    records = [record for batch in batches.values() for record in batch]
    mine = [record for record in records if record.value == b"isto nao e json"]
    assert mine
    headers = dict(mine[-1].headers)
    assert headers["dlt.consumer.group"] == b"notification-service"
    assert headers["dlt.error.class"] == b"ContractError"

"""Fase 6: o e-mail de reembolso concluído e o PDF do relatório financeiro sob demanda.

O relatório vem do analytics (fake HTTP, com o token da conta de serviço), a
tarefa passa pela fila `reports.generate` de um RabbitMQ real e o PDF chega ao
Mailpit anexado ao e-mail do produtor.
"""

import json
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import aio_pika
import httpx
from aiokafka import AIOKafkaProducer

from notification.api.app import create_app
from notification.dlq import REQUEUE_COUNT_HEADER, requeue
from notification.ids import uuid7
from notification.rabbit import topology
from notification.rabbit.dead_letter import ERROR_HEADER, ORIGINAL_QUEUE_HEADER
from notification.rabbit.publisher import Publisher
from notification.service import Components
from tests.events import order_refunded
from tests.fakes import FakeBackends
from tests.integration.conftest import MailpitApi, Telemetry, publish, queue_depth, wait_for
from tests.pdfs import read_pdf
from tests.tokens import FakeKeycloak

URL = "/v1/reports/statements"


async def test_refund_becomes_an_email_with_the_amount_and_the_show(
    run_service: Any, backends: FakeBackends, producer: AIOKafkaProducer, mailpit: MailpitApi
) -> None:
    show_id = backends.add_show(title="Noite Reembolsada", timezone="America/Manaus")
    buyer_id = backends.add_buyer(email="bia@lotou.test", first_name="Bia")
    message = order_refunded(buyer_id=buyer_id, show_id=show_id, reason="SHOW_CANCELLED")

    async with run_service(components=frozenset({"kafka", "email"})):
        await publish(producer, message)
        [summary] = await mailpit.wait_for(1)

    detail = await mailpit.message(summary["ID"])
    assert [to["Address"] for to in detail["To"]] == ["bia@lotou.test"]
    assert detail["Subject"] == "Reembolso concluído: Noite Reembolsada"
    text = detail["Text"]
    assert "Olá, Bia!" in text
    # 320,00 - 32,00 de cupom + 32,00 de taxa, tudo de volta.
    assert "Valor devolvido: R$ 320,00, taxa de serviço incluída." in text
    assert "o show foi cancelado pelo produtor" in text
    assert "sábado, 12 de dezembro de 2026, às 20h00 (horário de America/Manaus)" in text
    assert message.payload["orderId"] in text
    assert detail["Attachments"] == []


@asynccontextmanager
async def api(make_settings: Any, backends: FakeBackends) -> AsyncIterator[tuple[httpx.AsyncClient, FakeKeycloak]]:
    """A API com o worker de relatório e o de e-mail, sem o consumidor do Kafka."""
    keycloak = FakeKeycloak()
    app = create_app(
        make_settings(),
        jwks_http=keycloak.http_client(),
        http=backends.client(),
        components=Components(enabled=frozenset({"reports", "email"})),
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://notification") as client,
    ):
        yield client, keycloak


async def test_owner_receives_the_statement_pdf_by_email(
    make_settings: Any, backends: FakeBackends, mailpit: MailpitApi, telemetry: Telemetry
) -> None:
    producer_id = backends.add_buyer(email="caio@lotou.test", first_name="Caio")
    show_id = backends.add_statement(producer_id)
    rendered = telemetry.value("statement_render_duration", result="ok")

    async with api(make_settings, backends) as (client, keycloak):
        response = await client.post(URL, json={"showId": show_id}, headers=keycloak.bearer(producer_id, ["producer"]))
        assert response.status_code == 202, response.text
        body = response.json()
        assert (body["showId"], body["status"]) == (show_id, "QUEUED")
        uuid.UUID(body["requestId"])
        [summary] = await mailpit.wait_for(1)

    detail = await mailpit.message(summary["ID"])
    assert [to["Address"] for to in detail["To"]] == ["caio@lotou.test"]
    assert detail["Subject"] == "Relatório financeiro: Samba de Quinta"
    assert "Valor a receber: R$ 364,50" in detail["Text"]
    [attachment] = detail["Attachments"]
    assert attachment["FileName"] == f"relatorio-{show_id}.pdf"
    assert attachment["ContentType"] == "application/pdf"
    [page] = read_pdf(await mailpit.attachment(summary["ID"], attachment["PartID"]))
    text = " ".join(page.text.split())
    assert "Valor a receber R$ 364,50" in text
    assert "Taxa de serviço absorvida -R$ 45,00" in text
    assert "Relatório parcial" in text
    assert "(horário de America/Sao_Paulo)" in text
    assert telemetry.value("statement_render_duration", result="ok") - rendered == 1


async def test_only_the_owner_can_ask_for_the_statement(
    make_settings: Any, backends: FakeBackends, rabbit: aio_pika.abc.AbstractRobustConnection
) -> None:
    owner = backends.add_buyer(email="caio@lotou.test")
    show_id = backends.add_statement(owner)

    async with api(make_settings, backends) as (client, keycloak):
        other = await client.post(URL, json={"showId": show_id}, headers=keycloak.bearer("outro", ["producer"]))
        unknown = await client.post(URL, json={"showId": uuid7()}, headers=keycloak.bearer(owner, ["producer"]))
        buyer = await client.post(URL, json={"showId": show_id}, headers=keycloak.bearer(owner, ["buyer"]))
        anonymous = await client.post(URL, json={"showId": show_id})
        invalid = await client.post(URL, json={"showId": "nao-e-uuid"}, headers=keycloak.bearer(owner, ["producer"]))
        backends.analytics_down = True
        down = await client.post(URL, json={"showId": show_id}, headers=keycloak.bearer(owner, ["producer"]))

    # Show de outro produtor é 404, igual ao que não existe: não revela que existe.
    for response, status, slug in (
        (other, 404, "not-found"),
        (unknown, 404, "not-found"),
        (buyer, 403, "forbidden"),
        (anonymous, 401, "unauthorized"),
        (invalid, 400, "validation-error"),
        (down, 503, "service-unavailable"),
    ):
        assert response.status_code == status, response.text
        assert response.headers["content-type"] == "application/problem+json"
        assert response.json()["type"] == f"urn:lotou:problem:{slug}"
    same = ("type", "title", "status", "detail")
    assert {key: other.json()[key] for key in same} == {key: unknown.json()[key] for key in same}
    # Nenhuma tarefa foi enfileirada.
    assert await queue_depth(rabbit, topology.REPORTS_QUEUE) == 0


async def test_same_idempotency_key_sends_a_single_email(
    make_settings: Any, backends: FakeBackends, mailpit: MailpitApi, telemetry: Telemetry
) -> None:
    producer_id = backends.add_buyer(email="caio@lotou.test")
    show_id = backends.add_statement(producer_id, partial=False)
    duplicates = telemetry.value("emails_sent", template="email.report.statement", result="duplicate")

    async with api(make_settings, backends) as (client, keycloak):
        headers = keycloak.bearer(producer_id, ["producer"]) | {"Idempotency-Key": "relatorio-1"}
        first = await client.post(URL, json={"showId": show_id}, headers=headers)
        second = await client.post(URL, json={"showId": show_id}, headers=headers)
        assert first.status_code == second.status_code == 202
        assert first.json()["requestId"] == second.json()["requestId"]
        await mailpit.wait_for(1)
        await wait_for(
            lambda: (
                telemetry.value("emails_sent", template="email.report.statement", result="duplicate") - duplicates == 1
            )
        )

    [message] = await mailpit.messages()
    assert "relatório financeiro (final)" in (await mailpit.message(message["ID"]))["Text"]


async def test_unreadable_report_task_goes_to_its_dlq_and_can_be_requeued(
    run_service: Any, rabbit: aio_pika.abc.AbstractRobustConnection, mailpit: MailpitApi, telemetry: Telemetry
) -> None:
    dead = telemetry.value("statements_rendered", result="dead_lettered")
    async with run_service(components=frozenset({"reports", "email"})) as service:
        publisher = Publisher(rabbit)
        message_id = uuid7()
        # Envelope certo, payload sem o relatório: repetir não adianta, vai direto para a DLQ.
        body = json.dumps(
            {
                "messageId": message_id,
                "type": "GenerateStatement",
                "version": 1,
                "createdAt": "2026-11-27T18:00:00Z",
                "payload": {"requestId": uuid7(), "producerId": "produtor-1"},
            }
        ).encode()
        await publisher.publish(
            topology.REPORTS, topology.STATEMENT_KEY, body, message_id=message_id, message_type="GenerateStatement"
        )
        await wait_for(lambda: queue_depth(rabbit, topology.REPORTS_DLQ))
        await wait_for(lambda: telemetry.value("notifications_dlq_depth", queue=topology.REPORTS_DLQ) == 1)

        channel = await rabbit.channel()
        dlq = await channel.declare_queue(topology.REPORTS_DLQ, passive=True)
        dead_message = await dlq.get(no_ack=False)
        assert dead_message.headers[ORIGINAL_QUEUE_HEADER] == topology.REPORTS_QUEUE
        assert "payload de GenerateStatement inválido" in str(dead_message.headers[ERROR_HEADER])
        await dead_message.nack(requeue=True)
        await channel.close()

        # O requeue devolve ao exchange `reports`; a tarefa continua ilegível e volta para a DLQ.
        assert service.connection is not None
        result = await requeue(service.connection, publisher, topology.REPORTS_DLQ)
        assert (result.requeued, result.skipped) == (1, 0)

        async def back_in_the_dlq() -> bool:
            channel = await rabbit.channel()
            try:
                queue = await channel.declare_queue(topology.REPORTS_DLQ, passive=True)
                message = await queue.get(no_ack=False, fail=False)
                if message is None:
                    return False
                await message.nack(requeue=True)
                return bool(message.headers.get(REQUEUE_COUNT_HEADER) == 1)
            finally:
                await channel.close()

        await wait_for(back_in_the_dlq)
        await publisher.close()

    assert telemetry.value("statements_rendered", result="dead_lettered") - dead == 2
    assert await mailpit.messages() == []

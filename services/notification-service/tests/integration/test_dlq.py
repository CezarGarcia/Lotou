"""O critério da fase 4: a DLQ demonstrada.

Com o SMTP fora do ar, o e-mail passa pelas 4 tentativas (as esperas de 10 s,
1 min e 5 min encurtadas para 0,4 s), cai em `notifications.email.dlq`, a métrica
`notifications_dlq_depth` mostra a mensagem, e o requeue pela API, com o SMTP de
volta, entrega o e-mail.
"""

import asyncio
import json
import os
import sys
from dataclasses import dataclass
from typing import Any

import aio_pika
import httpx
from aiokafka import AIOKafkaProducer

from notification import tasks
from notification.api.app import create_app
from notification.dlq import REQUEUE_COUNT_HEADER, requeue
from notification.ids import uuid7
from notification.rabbit import topology
from notification.rabbit.dead_letter import ERROR_HEADER, ORIGINAL_QUEUE_HEADER
from notification.rabbit.publisher import Publisher
from notification.rabbit.retry import ATTEMPT_HEADER
from notification.service import Components
from tests.events import order_cancelled, tickets_issued
from tests.fakes import FakeBackends
from tests.integration.conftest import Infra, MailpitApi, Telemetry, closed_port, publish, queue_depth, wait_for
from tests.tokens import FakeKeycloak


async def test_failing_smtp_goes_to_the_dlq_after_four_attempts_and_requeue_delivers(
    run_service: Any,
    make_settings: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
    telemetry: Telemetry,
) -> None:
    show_id = backends.add_show(title="Noite sem SMTP")
    buyer_id = backends.add_buyer(email="bia@lotou.test")
    template = "email.order.cancelled"
    retried = telemetry.value("emails_sent", template=template, result="retried")
    dead = telemetry.value("emails_sent", template=template, result="dead_lettered")

    # ---- SMTP fora do ar: 4 tentativas e a DLQ
    async with run_service(smtp_port=closed_port()):
        await publish(producer, order_cancelled(buyer_id=buyer_id, show_id=show_id))
        await wait_for(lambda: queue_depth(rabbit, topology.EMAIL_DLQ), 20)
        await wait_for(lambda: telemetry.value("notifications_dlq_depth", queue=topology.EMAIL_DLQ) == 1)

    assert telemetry.value("emails_sent", template=template, result="retried") - retried == 3
    assert telemetry.value("emails_sent", template=template, result="dead_lettered") - dead == 1
    assert await queue_depth(rabbit, topology.EMAIL_DLQ) == 1
    assert await queue_depth(rabbit, topology.EMAIL_QUEUE) == 0
    assert await mailpit.messages() == []

    # A mensagem na DLQ diz quantas tentativas fez, por que falhou e de onde veio,
    # sem o endereço do comprador.
    channel = await rabbit.channel()
    dlq = await channel.declare_queue(topology.EMAIL_DLQ, passive=True)
    dead_message = await dlq.get(no_ack=False)
    headers = dead_message.headers
    assert headers[ATTEMPT_HEADER] == 4
    assert headers[ORIGINAL_QUEUE_HEADER] == topology.EMAIL_QUEUE
    assert "SmtpFailed" in str(headers[ERROR_HEADER])
    assert "@" not in str(headers[ERROR_HEADER])
    assert dead_message.priority == 5
    await dead_message.nack(requeue=True)
    await channel.close()

    # ---- SMTP de volta: requeue pela API interna, com o token de uma conta de serviço
    keycloak = FakeKeycloak()
    app = create_app(
        make_settings(),
        jwks_http=keycloak.http_client(),
        http=backends.client(),
        components=Components(enabled=frozenset({"email"})),
    )
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://notification") as client,
    ):
        assert (await client.post("/internal/v1/dlq/requeue")).status_code == 401
        forbidden = await client.post("/internal/v1/dlq/requeue", headers=keycloak.bearer("comprador", ["buyer"]))
        assert forbidden.status_code == 403
        assert forbidden.headers["content-type"] == "application/problem+json"

        service = keycloak.bearer("service-account-ops", ["service"])
        state = await client.get("/internal/v1/dlq", headers=service)
        assert {"queue": topology.EMAIL_DLQ, "messages": 1} in state.json()["queues"]

        response = await client.post("/internal/v1/dlq/requeue", json={"queue": topology.EMAIL_DLQ}, headers=service)
        assert response.status_code == 200
        assert response.json() == {"queue": topology.EMAIL_DLQ, "requeued": 1, "skipped": 0}

        [summary] = await mailpit.wait_for(1)
        assert summary["Subject"] == "Pedido cancelado: Noite sem SMTP"
        assert [to["Address"] for to in summary["To"]] == ["bia@lotou.test"]
        await wait_for(lambda: telemetry.value("notifications_dlq_depth", queue=topology.EMAIL_DLQ) == 0)
        state = await client.get("/internal/v1/dlq", headers=service)
        assert {"queue": topology.EMAIL_DLQ, "messages": 0} in state.json()["queues"]


async def test_keycloak_failure_recovers_within_the_retries(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
    telemetry: Telemetry,
) -> None:
    """Uma falha passageira não chega à DLQ: o retry de 10 s (aqui 0,4 s) resolve."""
    show_id = backends.add_show(title="Noite Instável")
    buyer_id = backends.add_buyer()
    backends.keycloak_down = True
    retried = telemetry.value("emails_sent", result="retried")

    async with run_service():
        await publish(producer, order_cancelled(buyer_id=buyer_id, show_id=show_id))
        await wait_for(lambda: telemetry.value("emails_sent", result="retried") - retried >= 1)
        backends.keycloak_down = False
        [summary] = await mailpit.wait_for(1)

    assert summary["Subject"] == "Pedido cancelado: Noite Instável"
    assert await queue_depth(rabbit, topology.EMAIL_DLQ) == 0


async def test_render_of_an_unknown_show_goes_to_its_dlq_and_comes_back(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
    telemetry: Telemetry,
) -> None:
    """Show que o event-service não conhece: repetir não adianta, vai direto para `tickets.render.dlq`."""
    buyer_id = backends.add_buyer()
    message = tickets_issued(buyer_id=buyer_id, show_id="01a21a00-0000-7000-8000-0000000000ff", seats=["E-1"])

    async with run_service():
        await publish(producer, message)
        await wait_for(lambda: telemetry.value("notifications_dlq_depth", queue=topology.RENDER_DLQ) == 1)

        channel = await rabbit.channel()
        dlq = await channel.declare_queue(topology.RENDER_DLQ, passive=True)
        dead_message = await dlq.get(no_ack=False)
        assert "não existe no event-service" in str(dead_message.headers[ERROR_HEADER])
        assert dead_message.headers[ORIGINAL_QUEUE_HEADER] == topology.RENDER_QUEUE
        await dead_message.nack(requeue=True)
        await channel.close()

        # O show aparece (a causa foi corrigida) e o requeue o leva de volta ao render.
        backends.shows["01a21a00-0000-7000-8000-0000000000ff"] = backends.shows[backends.add_show(title="Achado")]
        publisher = Publisher(rabbit)
        result = await requeue(rabbit, publisher, topology.RENDER_DLQ)
        await publisher.close()
        assert (result.requeued, result.skipped) == (1, 0)
        [summary] = await mailpit.wait_for(1)

    assert summary["Subject"] == "Seus ingressos para Achado"
    assert await queue_depth(rabbit, topology.RENDER_DLQ) == 0


async def test_event_service_down_holds_the_render_until_it_comes_back(
    run_service: Any,
    backends: FakeBackends,
    producer: AIOKafkaProducer,
    rabbit: aio_pika.abc.AbstractRobustConnection,
    mailpit: MailpitApi,
) -> None:
    show_id = backends.add_show(title="Noite Atrasada")
    buyer_id = backends.add_buyer()
    backends.event_service_down = True

    async with run_service():
        await publish(producer, tickets_issued(buyer_id=buyer_id, show_id=show_id, seats=["F-1"]))
        await wait_for(lambda: backends.show_calls >= 3)
        assert await mailpit.messages() == []
        backends.event_service_down = False
        [summary] = await mailpit.wait_for(1)

    assert summary["Subject"] == "Seus ingressos para Noite Atrasada"
    assert await queue_depth(rabbit, topology.RENDER_DLQ) == 0


async def test_command_line_moves_the_dlq_back(
    rabbit: aio_pika.abc.AbstractRobustConnection, infra: Infra, backends: FakeBackends
) -> None:
    """`python -m notification.dlq`, o que o `make requeue-notifications` roda no container."""
    email = tasks.CancellationEmail(
        source_event_id=uuid7(),
        buyer_id=backends.add_buyer(),
        order_id=uuid7(),
        show_id=uuid7(),
        total_cents=1000,
        reason="PAYMENT_DECLINED",
        cancelled_at="2026-11-26T18:00:02Z",  # type: ignore[arg-type]
    )
    publisher = Publisher(rabbit)
    message_id = uuid7()
    dead = {ATTEMPT_HEADER: 4, ERROR_HEADER: "SmtpFailed: fora do ar", ORIGINAL_QUEUE_HEADER: topology.EMAIL_QUEUE}
    body = tasks.encode(tasks.SendEmail(email=email), message_id=message_id)
    await publisher.publish(
        topology.NOTIFICATIONS_DLX, "", body, message_id=message_id, message_type="SendEmail", headers=dead, priority=5
    )
    await publisher.publish(
        topology.NOTIFICATIONS_DLX, "", b"ilegivel", message_id=uuid7(), message_type="SendEmail", headers=dead
    )
    await publisher.close()

    depth = await _cli(infra, "depth")
    assert (depth.returncode, json.loads(depth.stdout)) == (0, {topology.EMAIL_DLQ: 2, topology.RENDER_DLQ: 0})

    moved = await _cli(infra, "requeue", "--queue", "email")
    assert moved.returncode == 2  # a ilegível ficou na DLQ
    assert json.loads(moved.stdout) == {"queue": topology.EMAIL_DLQ, "requeued": 1, "skipped": 1}

    assert await queue_depth(rabbit, topology.EMAIL_DLQ) == 1
    channel = await rabbit.channel()
    queue = await channel.declare_queue(topology.EMAIL_QUEUE, passive=True, robust=False)
    back = await queue.get(no_ack=False)
    assert back.body == body
    assert back.routing_key == "email.order.cancelled"
    assert back.priority == 5
    assert back.headers[ATTEMPT_HEADER] == 1
    assert back.headers[REQUEUE_COUNT_HEADER] == 1
    assert ERROR_HEADER not in back.headers
    await back.ack()
    await channel.close()


@dataclass
class _Run:
    returncode: int
    stdout: str


async def _cli(infra: Infra, *args: str) -> _Run:
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-m",
        "notification.dlq",
        *args,
        env={**os.environ, "RABBITMQ_URL": infra.rabbitmq.url},
        stdout=asyncio.subprocess.PIPE,
    )
    stdout, _ = await process.communicate()
    assert process.returncode is not None
    return _Run(process.returncode, stdout.decode())

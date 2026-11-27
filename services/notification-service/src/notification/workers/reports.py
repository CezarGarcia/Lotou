"""Worker de `reports.generate`: gera o PDF do relatório financeiro e enfileira o e-mail ao produtor.

1. Lê a tarefa `GenerateStatement` (o relatório do analytics, buscado quando o
   produtor pediu, e quem pediu).
2. Gera o PDF no pool de processos (`statement_render_duration_seconds`).
3. Publica `SendEmail` (`email.report.statement`) em `notifications`, com o PDF
   em base64, e espera a confirmação do broker. O worker de e-mail busca o
   endereço do produtor no Keycloak pelo `producerId` e cuida do retry e da DLQ
   do envio, como nos outros e-mails.
4. Só então confirma a tarefa (ack).

Falhas: tarefa ilegível ou erro ao gerar o PDF vão para `reports.generate.dlq`
(repetir não muda nada), de onde voltam com o requeue depois da correção.
RabbitMQ sem confirmar o e-mail: a tarefa volta para a fila (nack) e é gerada de
novo; o e-mail repetido é barrado pela marca do id do pedido de relatório.

A fila tem prefetch 1 e um consumidor: o relatório é raro (um clique do
produtor) e divide o pool de processos com os PDFs dos ingressos.
"""

import logging
import time

from aio_pika.abc import AbstractIncomingMessage
from opentelemetry import metrics, trace

from notification import tasks
from notification.ids import utcnow, uuid7
from notification.rabbit import topology
from notification.rabbit.dead_letter import send_to_dlq
from notification.rabbit.publisher import Publisher
from notification.rabbit.retry import ATTEMPT_HEADER
from notification.render.pool import RenderPool
from notification.render.statement import StatementJob

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("notification-service")
meter = metrics.get_meter("notification-service")

statement_duration = meter.create_histogram(
    "statement_render_duration",
    unit="s",
    description="Tempo para gerar o PDF do relatório financeiro de um show, por resultado",
)
statements_counter = meter.create_counter(
    "statements_rendered",
    unit="{report}",
    description="PDFs de relatório financeiro gerados, por resultado (rendered, dead_lettered)",
)


class ReportHandler:
    def __init__(self, *, publisher: Publisher, pool: RenderPool) -> None:
        self._publisher = publisher
        self._pool = pool

    async def __call__(self, message: AbstractIncomingMessage) -> None:
        try:
            _, task = tasks.decode(message.body, tasks.GenerateStatement)
        except tasks.InvalidTask as error:
            await self._dead_letter(message, str(error))
            return

        data = task.statement
        span = trace.get_current_span()
        span.set_attribute("lotou.report.id", task.request_id)
        span.set_attribute("lotou.show.id", data.show_id)

        job = StatementJob(
            request_id=task.request_id,
            title=data.title,
            artist=data.artist,
            starts_at=data.starts_at,
            timezone=data.timezone,
            venue_name=data.venue_name,
            partial=data.partial,
            gross_sales_cents=data.gross_sales_cents,
            discounts_cents=data.discounts_cents,
            refunds_cents=data.refunds_cents,
            platform_fee_cents=data.platform_fee_cents,
            buyer_fees_cents=data.buyer_fees_cents,
            receivable_cents=data.receivable_cents,
            confirmed_orders=data.confirmed_orders,
            refunded_orders=data.refunded_orders,
            tickets_sold=data.tickets_sold,
            tickets_refunded=data.tickets_refunded,
            data_at=task.requested_at,
            generated_at=utcnow(),
        )
        started = time.perf_counter()
        with tracer.start_as_current_span(
            "statement render", attributes={"lotou.report.id": task.request_id, "lotou.show.id": data.show_id}
        ):
            try:
                pdf = await self._pool.statement(job)
            except Exception as error:
                statement_duration.record(time.perf_counter() - started, {"result": "error"})
                logger.exception("Falha ao gerar o PDF do relatório", extra={"reportId": task.request_id})
                await self._dead_letter(message, f"{type(error).__name__}: {error}")
                return
        statement_duration.record(time.perf_counter() - started, {"result": "ok"})

        email = tasks.StatementEmail(
            source_event_id=task.request_id,
            producer_id=task.producer_id,
            show_id=data.show_id,
            title=data.title,
            partial=data.partial,
            receivable_cents=data.receivable_cents,
            attachment=tasks.Attachment.pdf(f"relatorio-{data.show_id}.pdf", pdf),
        )
        message_id = uuid7()
        try:
            await self._publisher.publish(
                topology.NOTIFICATIONS,
                tasks.routing_key(email),
                tasks.encode(tasks.SendEmail(email=email), message_id=message_id),
                message_id=message_id,
                message_type="SendEmail",
                headers={ATTEMPT_HEADER: 1},
                priority=tasks.priority(email),
            )
        except Exception:
            logger.warning(
                "E-mail do relatório não confirmado pelo RabbitMQ; a tarefa volta para a fila",
                extra={"reportId": task.request_id},
                exc_info=True,
            )
            try:
                await message.nack(requeue=True)
            except Exception:
                logger.debug("nack não enviado; o broker devolve a mensagem ao fechar o canal", exc_info=True)
            return
        await message.ack()
        statements_counter.add(1, {"result": "rendered"})
        logger.info(
            "Relatório gerado e e-mail enfileirado",
            extra={"reportId": task.request_id, "showId": data.show_id, "pdfBytes": len(pdf)},
        )

    async def _dead_letter(self, message: AbstractIncomingMessage, error: str) -> None:
        logger.error("Tarefa de relatório enviada para a DLQ", extra={"messageId": message.message_id, "error": error})
        await send_to_dlq(
            self._publisher, message, dlx=topology.REPORTS_DLX, queue=topology.REPORTS_QUEUE, error=error, attempt=1
        )
        statements_counter.add(1, {"result": "dead_lettered"})

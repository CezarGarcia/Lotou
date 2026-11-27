"""Worker de `tickets.render`: gera o PDF do pedido e enfileira o e-mail com ele.

1. Lê a tarefa `RenderTickets`.
2. Busca o show no event-service (título, artista, data, local e fuso).
3. Gera o PDF no pool de processos (`ticket_render_duration_seconds`).
4. Publica `SendEmail` (`email.ticket.issued`) em `notifications`, com
   prioridade alta e o PDF em base64, e espera a confirmação do broker.
5. Só então confirma a tarefa (ack).

Falhas:

- event-service fora do ar, 5xx ou 429: a tarefa fica com este worker, que
  tenta de novo com espera crescente (até 30 s entre tentativas). Os outros
  PDFs esperam na fila, duráveis; quando o event-service volta, tudo anda.
- tarefa ilegível, show que não existe ou erro ao gerar o PDF: repetir não
  muda nada, vai para `tickets.render.dlq` (com o motivo no cabeçalho `x-error`),
  de onde volta com o requeue depois da correção.
- RabbitMQ sem confirmar o e-mail: a tarefa volta para a fila (nack) e é
  gerada de novo; o e-mail repetido é barrado pela marca do `eventId`.
"""

import asyncio
import logging
import time

from aio_pika.abc import AbstractIncomingMessage
from opentelemetry import metrics, trace

from notification import tasks
from notification.clients.shows import ShowDirectory, ShowNotFound, ShowsUnavailable
from notification.ids import uuid7
from notification.rabbit import topology
from notification.rabbit.dead_letter import send_to_dlq
from notification.rabbit.publisher import Publisher
from notification.rabbit.retry import ATTEMPT_HEADER
from notification.render.pdf import PdfJob, PdfTicket
from notification.render.pool import RenderPool

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("notification-service")
meter = metrics.get_meter("notification-service")

render_duration = meter.create_histogram(
    "ticket_render_duration",
    unit="s",
    description="Tempo para gerar o PDF de um pedido (QR codes e páginas), por resultado",
)
renders_counter = meter.create_counter(
    "tickets_rendered",
    unit="{order}",
    description="PDFs de pedido gerados, por resultado (rendered, dead_lettered)",
)

MAX_WAIT_SECONDS = 30.0


class RenderHandler:
    def __init__(
        self,
        *,
        shows: ShowDirectory,
        publisher: Publisher,
        pool: RenderPool,
        stopping: asyncio.Event,
        retry_base_seconds: float = 1.0,
    ) -> None:
        self._shows = shows
        self._publisher = publisher
        self._pool = pool
        self._stopping = stopping
        self._retry_base = retry_base_seconds

    async def __call__(self, message: AbstractIncomingMessage) -> None:
        try:
            _, task = tasks.decode(message.body, tasks.RenderTickets)
        except tasks.InvalidTask as error:
            await self._dead_letter(message, str(error))
            return

        span = trace.get_current_span()
        span.set_attribute("lotou.order.id", task.order_id)
        span.set_attribute("lotou.event.id", task.source_event_id)

        try:
            show = await self._show(task.show_id)
        except ShowNotFound as error:
            await self._dead_letter(message, str(error))
            return
        except _Stopping:
            # Parada no meio da espera pelo event-service: a tarefa volta à fila.
            await message.nack(requeue=True)
            return

        job = PdfJob(
            order_id=task.order_id,
            title=show.title,
            artist=show.artist,
            starts_at=show.starts_at,
            timezone=show.timezone,
            venue_name=show.venue_name,
            venue_city=show.venue_city,
            venue_state=show.venue_state,
            tickets=tuple(PdfTicket(t.ticket_id, t.sector_name, t.seat, t.code) for t in task.tickets),
        )
        started = time.perf_counter()
        with tracer.start_as_current_span(
            "ticket render", attributes={"lotou.order.id": task.order_id, "lotou.tickets": len(task.tickets)}
        ):
            try:
                pdf = await self._pool.render(job)
            except Exception as error:
                render_duration.record(time.perf_counter() - started, {"result": "error"})
                logger.exception("Falha ao gerar o PDF", extra={"orderId": task.order_id})
                await self._dead_letter(message, f"{type(error).__name__}: {error}")
                return
        render_duration.record(time.perf_counter() - started, {"result": "ok"})

        email = tasks.TicketsEmail(
            source_event_id=task.source_event_id,
            buyer_id=task.buyer_id,
            order_id=task.order_id,
            show_id=task.show_id,
            show=show,
            ticket_count=len(task.tickets),
            attachment=tasks.Attachment.pdf(f"ingressos-{task.order_id}.pdf", pdf),
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
                "E-mail do ingresso não confirmado pelo RabbitMQ; o PDF volta para a fila",
                extra={"orderId": task.order_id},
                exc_info=True,
            )
            await _nack_quietly(message)
            return
        await message.ack()
        renders_counter.add(1, {"result": "rendered"})
        logger.info(
            "PDF gerado e e-mail enfileirado",
            extra={"orderId": task.order_id, "tickets": len(task.tickets), "pdfBytes": len(pdf)},
        )

    async def _show(self, show_id: str) -> tasks.ShowInfo:
        attempt = 0
        while True:
            try:
                return await self._shows.get(show_id)
            except ShowsUnavailable as error:
                attempt += 1
                wait = min(MAX_WAIT_SECONDS, self._retry_base * 2 ** (attempt - 1))
                logger.warning(
                    "event-service indisponível; tentando de novo",
                    extra={"showId": show_id, "attempt": attempt, "waitSeconds": wait, "error": str(error)},
                )
                try:
                    await asyncio.wait_for(self._stopping.wait(), timeout=wait)
                except TimeoutError:
                    continue
                raise _Stopping from None

    async def _dead_letter(self, message: AbstractIncomingMessage, error: str) -> None:
        logger.error("Tarefa de PDF enviada para a DLQ", extra={"messageId": message.message_id, "error": error})
        await send_to_dlq(
            self._publisher, message, dlx=topology.TICKETS_DLX, queue=topology.RENDER_QUEUE, error=error, attempt=1
        )
        renders_counter.add(1, {"result": "dead_lettered"})


class _Stopping(Exception):
    pass


async def _nack_quietly(message: AbstractIncomingMessage) -> None:
    # Com a conexão caída, nem o nack chega; o broker devolve a mensagem à
    # fila sozinho quando o canal fecha.
    try:
        await message.nack(requeue=True)
    except Exception:
        logger.debug("nack não enviado; o broker devolve a mensagem ao fechar o canal", exc_info=True)

"""Worker de `notifications.email`: resolve o endereço do comprador e envia o e-mail.

1. Lê a tarefa `SendEmail` e a tentativa (`x-attempt`).
2. Reserva o e-mail daquele `eventId` (`notification:email:{eventId}`, em
   `dedupe.py`); se ele já saiu ou outra cópia está enviando, só confirma.
3. Busca o e-mail e o nome do comprador no Keycloak, pelo `buyerId`. Comprador
   sem e-mail (contas de serviço do smoke e da carga) é confirmado e contado,
   sem retry: tentar de novo não faria aparecer um endereço.
4. Monta o e-mail (texto e HTML, com o PDF no do ingresso) e envia por SMTP.
5. Marca o `eventId` como enviado e confirma (ack).

Se o passo 3 ou 4 falha (Keycloak, event-service ou SMTP fora, ou um erro
inesperado), a mensagem é republicada em `notifications.retry` com a chave da
espera daquela tentativa e `x-attempt` + 1, e a original é confirmada. Depois da
4ª tentativa, vai para `notifications.email.dlq` (`rabbit/retry.py`).

Métrica `emails_sent_total{template, result}`: `sent`, `retried`,
`dead_lettered`, `no_recipient`, `duplicate` e `invalid`.
"""

import asyncio
import logging
from email.message import EmailMessage

from aio_pika.abc import AbstractIncomingMessage
from opentelemetry import metrics, trace

from notification import tasks
from notification.clients.buyers import Buyer, BuyerDirectory
from notification.clients.shows import ShowDirectory, ShowNotFound
from notification.dedupe import Claim, Dedupe, email_key
from notification.ids import uuid7
from notification.mail import compose
from notification.mail.sender import SmtpSender
from notification.privacy import redact
from notification.rabbit import topology
from notification.rabbit.dead_letter import send_to_dlq
from notification.rabbit.publisher import Publisher, carried_headers
from notification.rabbit.retry import ATTEMPT_HEADER, GiveUp, attempt_of, next_step

logger = logging.getLogger(__name__)
meter = metrics.get_meter("notification-service")

emails_counter = meter.create_counter(
    "emails_sent",
    unit="{email}",
    description="E-mails tratados, por template e resultado (sent, retried, dead_lettered, no_recipient, ...)",
)


class EmailHandler:
    def __init__(
        self,
        *,
        buyers: BuyerDirectory,
        shows: ShowDirectory,
        sender: SmtpSender,
        publisher: Publisher,
        dedupe: Dedupe,
        mail_from: str,
    ) -> None:
        self._buyers = buyers
        self._shows = shows
        self._sender = sender
        self._publisher = publisher
        self._dedupe = dedupe
        self._mail_from = mail_from

    async def __call__(self, message: AbstractIncomingMessage) -> None:
        attempt = attempt_of(message.headers)
        span = trace.get_current_span()
        span.set_attribute("lotou.attempt", attempt)
        try:
            _, task = tasks.decode(message.body, tasks.SendEmail)
        except tasks.InvalidTask as error:
            logger.error("Tarefa de e-mail ilegível; vai para a DLQ", extra={"messageId": message.message_id})
            await self._dead_letter(message, str(error), attempt)
            _count("unknown", "invalid")
            return

        email = task.email
        template = email.template
        span.set_attribute("lotou.email.template", template)
        span.set_attribute("lotou.order.id", email.order_id)
        context = {"orderId": email.order_id, "template": template, "attempt": attempt}

        key = email_key(email.source_event_id)
        owner = message.message_id or uuid7()
        claim = await self._dedupe.claim(key, owner)
        if claim is not Claim.CLAIMED:
            await message.ack()
            _count(template, "duplicate")
            logger.info("Cópia de e-mail já enviado ou em envio; descartada", extra={**context, "claim": claim.value})
            return

        try:
            buyer = await self._buyers.get(email.buyer_id)
            if buyer.email is None:
                await self._dedupe.complete(key)
                await message.ack()
                _count(template, "no_recipient")
                logger.info("Comprador sem e-mail; nada a enviar", extra={**context, "buyerId": email.buyer_id})
                return
            await self._sender.send(await self._compose(email, buyer), template=template)
        except asyncio.CancelledError:
            await self._dedupe.release(key, owner)
            raise
        except Exception as error:
            # Solta a reserva: a próxima tentativa (ou outra cópia) pode enviar.
            await self._dedupe.release(key, owner)
            await self._failed(message, email, attempt, error)
            return

        await self._dedupe.complete(key)
        await message.ack()
        _count(template, "sent")
        logger.info("E-mail enviado", extra=context)

    async def _compose(self, email: tasks.TicketsEmail | tasks.CancellationEmail, buyer: Buyer) -> EmailMessage:
        if isinstance(email, tasks.TicketsEmail):
            return compose.tickets_email(email, buyer, sender=self._mail_from)
        try:
            show: tasks.ShowInfo | None = await self._shows.get(email.show_id)
        except ShowNotFound:
            show = None
        return compose.cancellation_email(email, buyer, show, sender=self._mail_from)

    async def _failed(
        self,
        message: AbstractIncomingMessage,
        email: tasks.TicketsEmail | tasks.CancellationEmail,
        attempt: int,
        error: Exception,
    ) -> None:
        reason = redact(f"{type(error).__name__}: {error}")
        context = {"orderId": email.order_id, "template": email.template, "attempt": attempt, "error": reason}
        trace.get_current_span().set_attribute("error.type", type(error).__name__)
        step = next_step(attempt)
        if isinstance(step, GiveUp):
            logger.error("E-mail falhou em todas as tentativas; vai para a DLQ", extra=context)
            await self._dead_letter(message, reason, attempt)
            _count(email.template, "dead_lettered")
            return

        headers = carried_headers(message.headers)
        headers[ATTEMPT_HEADER] = step.next_attempt
        try:
            await self._publisher.publish(
                topology.NOTIFICATIONS_RETRY,
                step.routing_key,
                message.body,
                message_id=message.message_id or "",
                message_type=message.type or "SendEmail",
                headers=headers,
                priority=message.priority,
                # Ao vencer a espera, a mensagem volta a `notifications` com esta chave.
                also_route_to=tasks.routing_key(email),
            )
        except Exception:
            logger.warning("Retry não confirmado pelo RabbitMQ; a mensagem volta para a fila", extra=context)
            try:
                await message.nack(requeue=True)
            except Exception:
                logger.debug("nack não enviado; o broker devolve a mensagem ao fechar o canal", exc_info=True)
            return
        await message.ack()
        _count(email.template, "retried")
        logger.warning(
            "Falha ao enviar o e-mail; nova tentativa agendada", extra={**context, "retry": step.routing_key}
        )

    async def _dead_letter(self, message: AbstractIncomingMessage, error: str, attempt: int) -> None:
        await send_to_dlq(
            self._publisher,
            message,
            dlx=topology.NOTIFICATIONS_DLX,
            queue=topology.EMAIL_QUEUE,
            error=error,
            attempt=attempt,
        )


def _count(template: str, result: str) -> None:
    emails_counter.add(1, {"template": template, "result": result})

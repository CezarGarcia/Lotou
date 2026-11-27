"""Envio de uma mensagem para a DLQ, com o motivo nos cabeçalhos.

A mensagem é publicada (com confirmação) no exchange de dead-letter da fila,
com os cabeçalhos `x-error` (classe e mensagem, sem e-mail), `x-failed-at`,
`x-attempt` (as tentativas feitas) e `x-original-queue`, e só depois a original
é confirmada. Se a publicação falhar, a original é rejeitada sem voltar à fila,
e o DLX declarado na fila a leva para a mesma DLQ, só sem os cabeçalhos.
"""

import logging

from aio_pika.abc import AbstractIncomingMessage

from notification.ids import utcnow, uuid7
from notification.privacy import redact
from notification.rabbit.publisher import Publisher, carried_headers
from notification.rabbit.retry import ATTEMPT_HEADER

logger = logging.getLogger(__name__)

ERROR_HEADER = "x-error"
FAILED_AT_HEADER = "x-failed-at"
ORIGINAL_QUEUE_HEADER = "x-original-queue"
_MAX_ERROR_LENGTH = 1000


async def send_to_dlq(
    publisher: Publisher,
    message: AbstractIncomingMessage,
    *,
    dlx: str,
    queue: str,
    error: str,
    attempt: int,
) -> None:
    headers = carried_headers(message.headers)
    headers.update(
        {
            ATTEMPT_HEADER: attempt,
            ERROR_HEADER: redact(error)[:_MAX_ERROR_LENGTH],
            FAILED_AT_HEADER: utcnow().isoformat(),
            ORIGINAL_QUEUE_HEADER: queue,
        }
    )
    try:
        await publisher.publish(
            dlx,
            "",
            message.body,
            message_id=message.message_id or uuid7(),
            message_type=message.type or "unknown",
            headers=headers,
            priority=message.priority,
        )
    except Exception:
        logger.warning("Falha ao publicar na DLQ; rejeitando para o DLX da fila", extra={"queue": queue}, exc_info=True)
        await message.reject(requeue=False)
        return
    await message.ack()

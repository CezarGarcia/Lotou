"""Topologia do RabbitMQ: exchanges, filas e ligações (`docs/projeto.md`, "RabbitMQ").

| Exchange | Tipo | Routing key | Fila |
| --- | --- | --- | --- |
| `tickets` | direct | `render` | `tickets.render` (DLX `tickets.dlx`) |
| `tickets.dlx` | fanout | | `tickets.render.dlq` |
| `notifications` | topic | `email.#` | `notifications.email` (prioridade até 10, DLX `notifications.dlx`) |
| `notifications.retry` | direct | `10s`, `1m`, `5m` | `notifications.retry.<chave>` (TTL; volta a `notifications`) |
| `notifications.dlx` | fanout | | `notifications.email.dlq` |

A declaração é idempotente: declarar o que já existe com os mesmos argumentos
não muda nada, então toda instância declara tudo na subida, e a conexão robusta
declara de novo depois de uma reconexão. Declarar uma fila que já existe com
outros argumentos (outro TTL, por exemplo) é recusado pelo broker
(`PRECONDITION_FAILED`): a fila precisa ser apagada antes.

As filas são clássicas e duráveis, e as mensagens são persistentes: sobrevivem a
uma reinicialização do broker. Fila clássica porque a de e-mail usa prioridade
de 0 a 10; quorum queues, o passo seguinte num cluster, têm só duas prioridades.
"""

from dataclasses import dataclass

from aio_pika import ExchangeType
from aio_pika.abc import AbstractChannel, AbstractExchange, AbstractQueue, AbstractRobustChannel

from notification.tasks import MAX_PRIORITY

TICKETS = "tickets"
TICKETS_DLX = "tickets.dlx"
RENDER_KEY = "render"
RENDER_QUEUE = "tickets.render"
RENDER_DLQ = "tickets.render.dlq"

NOTIFICATIONS = "notifications"
NOTIFICATIONS_RETRY = "notifications.retry"
NOTIFICATIONS_DLX = "notifications.dlx"
EMAIL_BINDING = "email.#"
EMAIL_QUEUE = "notifications.email"
EMAIL_DLQ = "notifications.email.dlq"

# Uma fila por espera; a chave é o nome, o tempo vem da configuração.
RETRY_KEYS: tuple[str, str, str] = ("10s", "1m", "5m")

DLQS: tuple[str, ...] = (EMAIL_DLQ, RENDER_DLQ)


def retry_queue(key: str) -> str:
    return f"{NOTIFICATIONS_RETRY}.{key}"


@dataclass(frozen=True)
class DeadLetterRoute:
    """De uma DLQ, para onde a mensagem volta numa nova rodada."""

    dlq: str
    exchange: str


# A chave de volta sai da tarefa (o template do e-mail, `render` no PDF), não
# do cabeçalho: depois de passar por uma fila de retry, a mensagem carrega
# várias routing keys.
REQUEUE_ROUTES: dict[str, DeadLetterRoute] = {
    EMAIL_DLQ: DeadLetterRoute(EMAIL_DLQ, NOTIFICATIONS),
    RENDER_DLQ: DeadLetterRoute(RENDER_DLQ, TICKETS),
}


async def declare(channel: AbstractChannel, retry_delays_seconds: tuple[float, ...]) -> dict[str, AbstractQueue]:
    """Declara a topologia inteira e devolve as filas por nome. Pode rodar quantas vezes for preciso.

    Cada canal que consome declara tudo de novo: o canal robusto do aio-pika
    repete essas declarações ao reconectar, então um broker que voltou sem os
    dados ganha a topologia de volta antes de o consumidor voltar a ler.
    """
    if len(retry_delays_seconds) != len(RETRY_KEYS):
        raise ValueError(f"são {len(RETRY_KEYS)} esperas de retry: {', '.join(RETRY_KEYS)}")

    # ---- ingressos
    tickets = await channel.declare_exchange(TICKETS, ExchangeType.DIRECT, durable=True)
    tickets_dlx = await channel.declare_exchange(TICKETS_DLX, ExchangeType.FANOUT, durable=True)
    render = await channel.declare_queue(RENDER_QUEUE, durable=True, arguments={"x-dead-letter-exchange": TICKETS_DLX})
    await render.bind(tickets, RENDER_KEY)
    render_dlq = await channel.declare_queue(RENDER_DLQ, durable=True)
    await render_dlq.bind(tickets_dlx, "")

    # ---- e-mails
    notifications = await channel.declare_exchange(NOTIFICATIONS, ExchangeType.TOPIC, durable=True)
    retry = await channel.declare_exchange(NOTIFICATIONS_RETRY, ExchangeType.DIRECT, durable=True)
    dlx = await channel.declare_exchange(NOTIFICATIONS_DLX, ExchangeType.FANOUT, durable=True)

    email = await channel.declare_queue(
        EMAIL_QUEUE,
        durable=True,
        arguments={"x-max-priority": MAX_PRIORITY, "x-dead-letter-exchange": NOTIFICATIONS_DLX},
    )
    await email.bind(notifications, EMAIL_BINDING)

    for key, seconds in zip(RETRY_KEYS, retry_delays_seconds, strict=True):
        # Sem `x-dead-letter-routing-key`: ao vencer o TTL, a mensagem volta a
        # `notifications` com as routing keys com que foi publicada. Ela é
        # publicada aqui com a chave da espera e, no cabeçalho `CC`, a do
        # template; a da espera não casa com nada em `notifications`, a do
        # template casa com `email.#` e a leva de volta a `notifications.email`.
        queue = await channel.declare_queue(
            retry_queue(key),
            durable=True,
            arguments={
                "x-message-ttl": round(seconds * 1000),
                "x-dead-letter-exchange": NOTIFICATIONS,
            },
        )
        await queue.bind(retry, key)

    email_dlq = await channel.declare_queue(EMAIL_DLQ, durable=True)
    await email_dlq.bind(dlx, "")

    return {queue.name: queue for queue in (render, render_dlq, email, email_dlq)}


async def depth(channel: AbstractRobustChannel, queue: str) -> int:
    """Mensagens prontas na fila, por uma declaração passiva (não cria nada).

    `robust=False`: o canal robusto guarda as filas declaradas para declarar de
    novo ao reconectar, e devolveria a mesma declaração (com a contagem velha)
    na chamada seguinte.
    """
    declared: AbstractQueue = await channel.declare_queue(queue, passive=True, robust=False)
    count = declared.declaration_result.message_count
    return int(count or 0)


async def exchange(channel: AbstractChannel, name: str) -> AbstractExchange:
    return await channel.get_exchange(name, ensure=False)

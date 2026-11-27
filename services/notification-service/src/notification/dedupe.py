"""Marcas no `redis-core` para uma reentrega não mandar outro e-mail.

Duas chaves, as duas pelo `eventId` do Kafka (nunca e-mail ou CPF na chave):

- `notification:event:{eventId}`: o evento já virou tarefa no RabbitMQ. Uma
  reentrega do Kafka (queda antes de confirmar o offset, rebalanceamento, o
  relay do outbox publicando de novo) é ignorada. Os eventos de uma partição
  são tratados um a um, então basta conferir antes e gravar (`SET NX` com TTL)
  **depois** de a tarefa ser confirmada: gravar antes e cair antes de publicar
  perderia o e-mail para sempre.
- `notification:email:{eventId}`: o e-mail daquele evento. Aqui duas cópias da
  mesma tarefa podem chegar juntas (o PDF gerado duas vezes porque o worker
  caiu antes do ack, e os dois e-mails tratados em paralelo), então a chave é
  uma reserva: `SET NX` com `sending:<messageId>` antes de enviar e `sent`
  depois. Uma cópia que encontra a reserva de outra é descartada (a outra é a
  responsável e, se falhar, solta a reserva e vai para o retry). A mesma
  mensagem entregue de novo depois de uma queda reconhece a própria reserva e
  segue.

A janela que sobra é uma queda entre o servidor SMTP aceitar e a marca `sent`:
ao menos uma vez, nunca nenhuma.

Se o Redis estiver fora, a deduplicação fica de fora e o fluxo segue (com um
aviso no log e na métrica): um e-mail repetido é melhor que um ingresso que não
chega.
"""

import enum
import logging

from opentelemetry import metrics
from redis.asyncio import Redis
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)
meter = metrics.get_meter("notification-service")

dedupe_unavailable = meter.create_counter(
    "notification_dedupe_unavailable",
    unit="{operation}",
    description="Consultas e marcas de deduplicação que não puderam usar o Redis",
)

SENT = "sent"
# Apaga a reserva só se ela ainda for de quem a pede.
_RELEASE = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
"""


def event_key(event_id: str) -> str:
    return f"notification:event:{event_id}"


def email_key(event_id: str) -> str:
    return f"notification:email:{event_id}"


class Claim(enum.Enum):
    CLAIMED = "claimed"  # esta cópia envia
    SENT = "sent"  # já enviado: descartar
    BUSY = "busy"  # outra cópia está enviando: descartar


class Dedupe:
    def __init__(self, redis: Redis, *, ttl_seconds: int, claim_ttl_seconds: int = 600) -> None:
        self._redis = redis
        self._ttl = ttl_seconds
        self._claim_ttl = claim_ttl_seconds

    # ------------------------------------------------- eventos do Kafka

    async def seen(self, key: str) -> bool:
        try:
            return bool(await self._redis.exists(key))
        except RedisError:
            self._unavailable("check", key)
            return False

    async def mark(self, key: str) -> None:
        try:
            await self._redis.set(key, "1", nx=True, ex=self._ttl)
        except RedisError:
            self._unavailable("mark", key)

    # ------------------------------------------------------- e-mails

    async def claim(self, key: str, owner: str) -> Claim:
        token = f"sending:{owner}"
        try:
            for _ in range(2):
                if await self._redis.set(key, token, nx=True, ex=self._claim_ttl):
                    return Claim.CLAIMED
                current = await self._redis.get(key)
                if current is None:
                    continue  # venceu entre o SET e o GET: tenta reservar de novo
                value = current.decode() if isinstance(current, bytes) else str(current)
                if value == SENT:
                    return Claim.SENT
                return Claim.CLAIMED if value == token else Claim.BUSY
        except RedisError:
            self._unavailable("claim", key)
        return Claim.CLAIMED

    async def complete(self, key: str) -> None:
        try:
            await self._redis.set(key, SENT, ex=self._ttl)
        except RedisError:
            self._unavailable("complete", key)

    async def release(self, key: str, owner: str) -> None:
        try:
            await self._redis.eval(_RELEASE, 1, key, f"sending:{owner}")
        except RedisError:
            self._unavailable("release", key)

    async def ping(self) -> bool:
        try:
            return bool(await self._redis.ping())
        except RedisError:
            return False

    def _unavailable(self, operation: str, key: str) -> None:
        logger.warning("Redis indisponível; seguindo sem deduplicação", extra={"operation": operation, "key": key})
        dedupe_unavailable.add(1, {"operation": operation})

"""Feed de atividade do painel: `stream:activity:{showId}`.

A projeção monta uma entrada quando aplica pela primeira vez um `OrderConfirmed`,
um `OrderCancelled` (o pedido entrou no estado agora, não é repetição nem fato
atrasado), um `LotOpened` ou um `LotSoldOut`. Só o consumidor ao vivo faz isso;
o replay não escreve no feed.

Uma vez só por evento, mesmo entre gerações: na troca de geração, o consumidor
ao vivo da geração nova reaplica os eventos que chegaram durante o replay, que a
geração antiga já tinha aplicado. Por isso a projeção registra o `eventId` em
`activity_log` (coleção fora das gerações), na mesma transação do efeito, e só
devolve a entrada se o registro é novo.

O `XADD` acontece depois que a transação confirma, porque o Redis não participa
dela. Se o processo cair entre as duas coisas, a entrada se perde: o evento já
está no `processed_events` e não volta. Para um feed isso é aceitável (os
números do painel vêm dos read models, não do feed); o contrário, gravar antes
da transação, poria no feed fatos que podem não ter sido aplicados. Uma falha do
Redis no `XADD` tem uma nova tentativa e depois é registrada em log, sem parar o
consumidor: o feed não pode atrasar os read models.
"""

import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from redis.asyncio import Redis
from redis.exceptions import RedisError

from analytics.contracts import Event, LotOpened, LotSoldOut, OrderCancelled, OrderConfirmed
from analytics.live import keys
from analytics.live.protocol import iso
from analytics.store.read_models import ACTIVITY_LOG

logger = logging.getLogger(__name__)

__all__ = ["ACTIVITY_LOG", "ActivityEntry", "ActivityFeed", "decode", "lot_entry", "order_entry"]


@dataclass(frozen=True)
class ActivityEntry:
    show_id: str
    event_id: str
    type: str
    at: datetime
    # Campos do tipo (`orderId`, `sectorName`...). Nada de comprador: nem o `buyerId`.
    fields: Mapping[str, Any] = field(default_factory=dict)

    def body(self) -> dict[str, Any]:
        """A entrada sem o `id`, que só existe depois do `XADD`."""
        return {"eventId": self.event_id, "type": self.type, "at": iso(self.at), **self.fields}


def order_entry(event: Event, payload: OrderConfirmed | OrderCancelled) -> ActivityEntry:
    fields: dict[str, Any]
    match payload:
        case OrderConfirmed():
            # Uma reserva é de um setor só: o primeiro item diz qual.
            fields = {
                "orderId": payload.order_id,
                "sectorName": payload.items[0].sector_name,
                "quantity": len(payload.items),
                "totalCents": payload.total_cents,
            }
        case OrderCancelled():
            fields = {"orderId": payload.order_id, "reason": payload.reason, "totalCents": payload.total_cents}
    return ActivityEntry(payload.show_id, event.event_id, event.type, event.envelope.occurred_at, fields)


def lot_entry(event: Event, payload: LotOpened | LotSoldOut, show: Mapping[str, Any] | None) -> ActivityEntry:
    """Os nomes vêm da cópia do catálogo; ficam `null` se o show ainda não chegou."""
    sector = next((s for s in (show or {}).get("sectors", []) if s["id"] == payload.sector_id), None)
    lot = next((item for item in (sector or {}).get("lots", []) if item["id"] == payload.lot_id), None)
    fields: dict[str, Any] = {
        "sectorName": sector["name"] if sector else None,
        "lotName": lot["name"] if lot else None,
    }
    if isinstance(payload, LotOpened):
        fields["priceCents"] = payload.price_cents
    return ActivityEntry(payload.show_id, event.event_id, event.type, event.envelope.occurred_at, fields)


def decode(stream_id: str, fields: Mapping[str, str]) -> dict[str, Any]:
    """Entrada lida do stream, no formato do protocolo (com o `id`)."""
    body: dict[str, Any] = json.loads(fields["entry"])
    return {"id": stream_id, **body}


class ActivityFeed:
    """Grava as entradas no Redis Stream de cada show, depois da transação."""

    def __init__(self, redis: Redis) -> None:
        self._redis = redis

    async def publish(self, entries: Sequence[ActivityEntry]) -> None:
        if not entries:
            return
        for attempt in (1, 2):
            try:
                await self._xadd(entries)
                return
            except RedisError:
                if attempt == 2:
                    logger.warning(
                        "Falha ao gravar o feed de atividade no Redis; entradas perdidas",
                        extra={"entries": len(entries), "eventIds": [entry.event_id for entry in entries]},
                        exc_info=True,
                    )

    async def _xadd(self, entries: Sequence[ActivityEntry]) -> None:
        async with self._redis.pipeline(transaction=False) as pipe:
            for entry in entries:
                # IDMP com o eventId: repetir este XADD (a nova tentativa acima) não duplica a entrada.
                pipe.execute_command(
                    "XADD",
                    keys.activity_stream(entry.show_id),
                    "IDMP",
                    keys.ACTIVITY_PRODUCER,
                    entry.event_id,
                    "MAXLEN",
                    "~",
                    keys.ACTIVITY_MAXLEN,
                    "*",
                    "entry",
                    json.dumps(entry.body(), ensure_ascii=False, separators=(",", ":")),
                )
            await pipe.execute()

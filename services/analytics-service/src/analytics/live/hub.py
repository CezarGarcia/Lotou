"""O lado Redis do painel ao vivo, em cada instância do analytics.

Cada instância guarda as assinaturas dos WebSockets conectados a ela e roda
quatro tarefas:

1. **Interesse.** A cada segundo, renova no ZSET `dashboard:watched` os shows
   que têm assinante aqui, com validade de `interest_ttl` (score = até quando,
   em ms). Um ZSET dá a lista de shows assistidos em qualquer instância num
   comando só, sem `SCAN`; uma instância que morre para de renovar e o
   interesse dela vence sozinho.
2. **Publicação das métricas.** No começo de cada segundo, toda instância lê os
   shows assistidos e disputa, por show, o segundo corrente num script Lua
   (`dashboard:metrics-tick:{showId}` guarda o último segundo calculado). Quem
   grava primeiro calcula as métricas na geração ativa e publica em
   `dashboard.metrics:{showId}`; as outras pulam o show naquele segundo. O
   trabalho se espalha entre as instâncias, e nenhuma é especial: sem eleição
   de líder, cair uma não deixa show sem métrica.
3. **Repasse das métricas.** Uma conexão de pub/sub por instância, assinando só
   os canais dos shows que têm assinante aqui.
4. **Leitura da atividade.** Um `XREAD BLOCK` por instância, em todos os streams
   dos shows assinados aqui, com um cursor por stream.

Nada se perde entre a foto e o ao vivo: a assinatura é registrada antes da foto
(`XREVRANGE`), o que o leitor traz nesse meio-tempo fica guardado nela, e cada
assinatura só recebe entradas com ID maior que o último que já recebeu.
"""

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import UTC, datetime
from typing import Any

from opentelemetry import metrics
from opentelemetry.instrumentation.utils import suppress_instrumentation
from redis.asyncio import Redis
from redis.asyncio.client import PubSub

from analytics.live import keys, protocol
from analytics.live.activity import decode
from analytics.live.connection import Connection, Frame
from analytics.live.keys import StreamId, format_stream_id, parse_stream_id
from analytics.live.metrics import compute
from analytics.store.generations import GenerationRegistry
from analytics.store.read_models import ReadModels

logger = logging.getLogger(__name__)
meter = metrics.get_meter("analytics-service")

subscriptions_gauge = meter.create_up_down_counter(
    "dashboard_subscriptions", unit="{subscription}", description="Shows assinados nos WebSockets desta instância"
)

SNAPSHOT_ACTIVITY = 50

# Grava o segundo no show se ele é mais novo que o último calculado: 1 para quem
# ganhou o segundo, 0 para quem chegou depois.
TICK_SCRIPT = """
local last = tonumber(redis.call('GET', KEYS[1]) or '-1')
if tonumber(ARGV[1]) > last then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0
"""


class Subscription:
    """Um show assinado por uma conexão."""

    def __init__(self, connection: Connection, show_id: str) -> None:
        self.connection = connection
        self.show_id = show_id
        # None enquanto a foto é montada: a atividade que chega fica em `buffer`.
        self.last_id: StreamId | None = None
        self.buffer: list[tuple[StreamId, Frame]] = []

    @property
    def live(self) -> bool:
        return self.last_id is not None

    def deliver(self, stream_id: StreamId, frame: Frame) -> None:
        if self.last_id is None:
            self.buffer.append((stream_id, frame))
        elif stream_id > self.last_id:
            self.last_id = stream_id
            self.connection.send(frame)

    def go_live(self, last_id: StreamId) -> None:
        """A foto foi para a fila com tudo até `last_id`; daqui para a frente, só o que é mais novo."""
        self.last_id = last_id
        buffered, self.buffer = self.buffer, []
        for stream_id, frame in sorted(buffered, key=lambda item: item[0]):
            self.deliver(stream_id, frame)


class LiveHub:
    def __init__(
        self,
        redis: Redis,
        registry: GenerationRegistry,
        *,
        metrics_interval: float = 1.0,
        interest_ttl: float = 5.0,
        activity_block_ms: int = 250,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._redis = redis
        self._registry = registry
        self._interval = metrics_interval
        self._interest_ttl_ms = int(interest_ttl * 1000)
        self._block_ms = activity_block_ms
        self._clock = clock
        self._connections: set[Connection] = set()
        self._subs: dict[str, dict[int, Subscription]] = {}
        self._cursors: dict[str, StreamId] = {}
        # Avisos de "as assinaturas mudaram", um para o pub/sub e outro para o leitor dos streams.
        self._relay_changed = asyncio.Event()
        self._reader_changed = asyncio.Event()
        self._stopping = asyncio.Event()
        self._tasks: list[asyncio.Task[None]] = []
        self._tick = redis.register_script(TICK_SCRIPT)

    # ------------------------------------------------------------ ciclo de vida

    async def start(self) -> None:
        # As tarefas de fundo rodam a cada segundo: um trace por volta seria só ruído.
        # Os comandos do Redis e do MongoDB delas ficam fora do OpenTelemetry.
        with suppress_instrumentation():
            self._tasks = [
                asyncio.create_task(self._every_interval(self._refresh_interest), name="live-interest"),
                asyncio.create_task(self._publish_metrics_loop(), name="live-metrics-publisher"),
                asyncio.create_task(self._relay_metrics(), name="live-metrics-relay"),
                asyncio.create_task(self._read_activity(), name="live-activity-reader"),
            ]

    async def stop(self) -> None:
        self._stopping.set()
        for connection in list(self._connections):
            connection.close(protocol.CLOSE_GOING_AWAY, "servidor reiniciando")
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()

    # --------------------------------------------------------------- conexões

    def connect(self, connection: Connection) -> None:
        self._connections.add(connection)

    def drop(self, connection: Connection) -> None:
        self._connections.discard(connection)
        for show_id in [show for show, subs in self._subs.items() if id(connection) in subs]:
            self.unsubscribe(connection, show_id)

    async def producer_of(self, show_id: str) -> str | None:
        """Dono do show na geração ativa; `None` se o show não existe."""
        models = await self._active_models()
        if models is None:
            return None
        show = await models.shows.find_one({"_id": show_id}, projection={"producerId": 1})
        return str(show["producerId"]) if show else None

    async def subscribe(self, connection: Connection, show_id: str) -> None:
        """Registra a assinatura, manda o `snapshot` e passa a repassar o show."""
        subs = self._subs.setdefault(show_id, {})
        first_here = not subs
        subscription = Subscription(connection, show_id)
        subs[id(connection)] = subscription
        subscriptions_gauge.add(1)
        self._notify()
        try:
            if first_here:
                await self._mark_watched([show_id])
            value, recent = await asyncio.gather(
                self._metrics_now(show_id),
                self._redis.xrevrange(keys.activity_stream(show_id), count=SNAPSHOT_ACTIVITY),
            )
        except BaseException:
            self.unsubscribe(connection, show_id)
            raise
        if self._subs.get(show_id, {}).get(id(connection)) is not subscription:
            return  # a conexão foi embora enquanto a foto era montada
        activity = [decode(stream_id, fields) for stream_id, fields in recent]
        last_id = parse_stream_id(recent[0][0]) if recent else (0, 0)
        connection.send(Frame(protocol.snapshot(show_id, value, activity), show_id))
        subscription.go_live(last_id)
        cursor = self._cursors.get(show_id)
        self._cursors[show_id] = last_id if cursor is None else min(cursor, last_id)
        self._notify()

    def unsubscribe(self, connection: Connection, show_id: str) -> None:
        subs = self._subs.get(show_id)
        if not subs or subs.pop(id(connection), None) is None:
            return
        subscriptions_gauge.add(-1)
        connection.forget(show_id)
        if not subs:
            # O interesse no Redis vence sozinho; outra instância pode estar assistindo.
            del self._subs[show_id]
            self._cursors.pop(show_id, None)
        self._notify()

    # ---------------------------------------------------------------- métricas

    async def publish_metrics(self) -> list[str]:
        """Uma volta da publicação. Devolve os shows calculados por esta instância."""
        now = self._clock()
        now_ms = int(now * 1000)
        tick = int(now // self._interval)
        await self._redis.zremrangebyscore(keys.WATCHED, "-inf", now_ms)
        watched = [str(show) for show in await self._redis.zrange(keys.WATCHED, 0, -1)]
        if not watched:
            return []
        won = await asyncio.gather(
            *(self._tick(keys=[keys.metrics_tick(show)], args=[tick, self._interest_ttl_ms]) for show in watched)
        )
        mine = [show for show, claimed in zip(watched, won, strict=True) if claimed == 1]
        models = await self._active_models()
        if not mine or models is None:
            return []
        at = datetime.fromtimestamp(now, UTC)
        limit = asyncio.Semaphore(8)

        async def publish(show_id: str) -> None:
            async with limit:
                value = await compute(models, show_id, at)
                if value is not None:
                    await self._redis.publish(keys.metrics_channel(show_id), json.dumps(value, ensure_ascii=False))

        results = await asyncio.gather(*(publish(show) for show in mine), return_exceptions=True)
        for show_id, result in zip(mine, results, strict=True):
            if isinstance(result, Exception):
                logger.warning("Falha ao calcular as métricas do show", extra={"showId": show_id}, exc_info=result)
        return mine

    async def _publish_metrics_loop(self) -> None:
        failing = _FailureLog("publicação das métricas do painel")
        while not self._stopping.is_set():
            # Todas as instâncias acordam no começo do segundo e disputam o mesmo tick.
            if await self._sleep(self._interval - self._clock() % self._interval):
                return
            try:
                await self.publish_metrics()
                failing.ok()
            except Exception:
                failing.failed()

    async def _metrics_now(self, show_id: str) -> dict[str, Any] | None:
        models = await self._active_models()
        if models is None:
            return None
        return await compute(models, show_id, datetime.fromtimestamp(self._clock(), UTC))

    async def _active_models(self) -> ReadModels | None:
        generation = await self._registry.active_generation()
        return ReadModels.of(self._registry.db, generation) if generation is not None else None

    # ---------------------------------------------------------------- interesse

    async def _refresh_interest(self) -> None:
        if self._subs:
            await self._mark_watched(list(self._subs))

    async def _mark_watched(self, show_ids: list[str]) -> None:
        until = int(self._clock() * 1000) + self._interest_ttl_ms
        await self._redis.zadd(keys.WATCHED, dict.fromkeys(show_ids, until), gt=True)

    async def _every_interval(self, action: Callable[[], Awaitable[None]]) -> None:
        failing = _FailureLog("renovação do interesse do painel")
        while not self._stopping.is_set():
            try:
                await action()
                failing.ok()
            except Exception:
                failing.failed()
            if await self._sleep(self._interval):
                return

    # ------------------------------------------------------------ repasse

    async def _relay_metrics(self) -> None:
        failing = _FailureLog("repasse das métricas do painel (pub/sub)")
        pubsub: PubSub | None = None
        subscribed: set[str] = set()
        while not self._stopping.is_set():
            try:
                if pubsub is None:
                    pubsub = self._redis.pubsub(ignore_subscribe_messages=True)
                    subscribed = set()
                wanted = set(self._subs)
                if added := wanted - subscribed:
                    await pubsub.subscribe(*(keys.metrics_channel(show) for show in added))
                    subscribed |= added
                if removed := subscribed - wanted:
                    await pubsub.unsubscribe(*(keys.metrics_channel(show) for show in removed))
                    subscribed -= removed
                if not subscribed:
                    await self._wait(self._relay_changed, 1.0)
                    continue
                message = await pubsub.get_message(timeout=0.25)
                while message is not None:
                    self._on_metrics(message)
                    message = await pubsub.get_message(timeout=0)
                failing.ok()
            except Exception:
                failing.failed()
                if pubsub is not None:
                    with suppress(Exception):
                        await pubsub.aclose()
                pubsub = None
                if await self._sleep(1.0):
                    break
        if pubsub is not None:
            with suppress(Exception):
                await pubsub.aclose()

    def _on_metrics(self, message: dict[str, Any]) -> None:
        if message.get("type") != "message":
            return
        show_id = keys.show_of_channel(str(message["channel"]))
        subs = self._subs.get(show_id)
        if not subs:
            return
        frame = Frame(protocol.metrics(show_id, json.loads(message["data"])), show_id)
        for subscription in list(subs.values()):
            if subscription.live:
                subscription.connection.send_metrics(show_id, frame)

    async def _read_activity(self) -> None:
        failing = _FailureLog("leitura do feed de atividade (XREAD)")
        while not self._stopping.is_set():
            streams: dict[Any, Any] = {
                keys.activity_stream(show): format_stream_id(cursor)
                for show, cursor in self._cursors.items()
                if show in self._subs
            }
            if not streams:
                await self._wait(self._reader_changed, 1.0)
                continue
            try:
                # Bloqueio curto: um show assinado agora entra na leitura seguinte.
                response: Any = await self._redis.xread(streams, count=200, block=self._block_ms)
                failing.ok()
            except Exception:
                failing.failed()
                if await self._sleep(1.0):
                    return
                continue
            for key, entries in response or []:
                self._on_activity(keys.show_of_stream(key), entries)

    def _on_activity(self, show_id: str, entries: list[tuple[str, dict[str, str]]]) -> None:
        for raw_id, fields in entries:
            stream_id = parse_stream_id(raw_id)
            cursor = self._cursors.get(show_id)
            if cursor is None:
                return  # ninguém mais assina o show aqui
            self._cursors[show_id] = max(cursor, stream_id)
            try:
                entry = decode(raw_id, fields)
                occurred_at = datetime.fromisoformat(entry["at"])
            except (KeyError, TypeError, ValueError):
                logger.warning("Entrada inválida no feed de atividade", extra={"showId": show_id, "id": raw_id})
                continue
            frame = Frame(protocol.activity(show_id, entry), show_id, occurred_at, str(entry.get("type")))
            for subscription in list(self._subs.get(show_id, {}).values()):
                subscription.deliver(stream_id, frame)

    # ------------------------------------------------------------ internos

    async def _sleep(self, seconds: float) -> bool:
        """Espera; devolve True se o hub foi parado nesse meio-tempo."""
        with suppress(TimeoutError):
            await asyncio.wait_for(self._stopping.wait(), timeout=max(seconds, 0.0))
        return self._stopping.is_set()

    def _notify(self) -> None:
        self._relay_changed.set()
        self._reader_changed.set()

    @staticmethod
    async def _wait(event: asyncio.Event, seconds: float) -> None:
        with suppress(TimeoutError):
            await asyncio.wait_for(event.wait(), timeout=seconds)
        event.clear()


class _FailureLog:
    """Registra a primeira falha de uma tarefa de fundo e a volta, sem repetir a cada segundo."""

    def __init__(self, what: str) -> None:
        self._what = what
        self._failing = False

    def failed(self) -> None:
        if not self._failing:
            logger.warning("Falha na %s; tentando de novo", self._what, exc_info=True)
        self._failing = True

    def ok(self) -> None:
        if self._failing:
            logger.info("A %s voltou", self._what)
        self._failing = False

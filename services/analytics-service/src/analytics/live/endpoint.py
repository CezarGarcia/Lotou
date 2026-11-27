"""WebSocket do painel ao vivo: `/v1/analytics/live` (`contracts/realtime-dashboard.md`).

1. A primeira mensagem é `auth`, em até `LIVE_AUTH_TIMEOUT_SECONDS` (senão,
   4408). O token passa pela mesma validação da API HTTP (ADR 21): inválido ou
   vencido fecha com 4401, sem o papel `producer` fecha com 4403.
2. Quando o token vence sem um `auth` novo, a conexão fecha com 4401. O `auth`
   de renovação precisa ser do mesmo usuário.
3. `subscribe` só para shows do produtor do token (o `producerId` do catálogo é
   o `sub`); senão, `error` `forbidden`, sem dizer se o show existe.

O ping de protocolo a cada 20 s é do uvicorn (`ws_ping_interval`, em
`analytics.__main__`), que também fecha a conexão se o pong não vier.

Spans: um para a conexão até a primeira autenticação, um por `auth` de
renovação e um por `subscribe`. Frames não viram span.
"""

import asyncio
import logging
import time
from collections.abc import MutableMapping
from dataclasses import dataclass
from enum import Enum
from typing import Any, Protocol

from fastapi import APIRouter, WebSocket
from opentelemetry import metrics, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from analytics.api.auth import TokenVerifier
from analytics.api.problems import ProblemError
from analytics.live import protocol
from analytics.live.connection import Connection, Frame
from analytics.live.protocol import Auth, BadMessage, Subscribe, Unsubscribe

logger = logging.getLogger(__name__)
tracer = trace.get_tracer("analytics-service")
meter = metrics.get_meter("analytics-service")

connections_gauge = meter.create_up_down_counter(
    "dashboard_connections", unit="{connection}", description="WebSockets do painel abertos nesta instância"
)

PATH = "/v1/analytics/live"
REQUIRED_ROLE = "producer"

router = APIRouter(tags=["live"])


class Hub(Protocol):
    def connect(self, connection: Connection) -> None: ...

    def drop(self, connection: Connection) -> None: ...

    async def subscribe(self, connection: Connection, show_id: str) -> None: ...

    def unsubscribe(self, connection: Connection, show_id: str) -> None: ...

    async def producer_of(self, show_id: str) -> str | None: ...


@dataclass(frozen=True)
class LiveOptions:
    auth_timeout: float = 5.0
    max_subscriptions: int = 20
    max_pending_frames: int = 500
    send_timeout: float = 10.0


@dataclass(frozen=True)
class Live:
    """O que o endpoint usa, em `app.state.live`."""

    hub: Hub
    verifier: TokenVerifier
    options: LiveOptions


@router.websocket(PATH)
async def live_dashboard(websocket: WebSocket) -> None:
    live: Live = websocket.app.state.live
    await LiveSession(websocket, live).run()


class _Event(Enum):
    TIMEOUT = "timeout"
    CLOSED = "closed"


class LiveSession:
    def __init__(self, websocket: WebSocket, live: Live) -> None:
        self._websocket = websocket
        self._hub = live.hub
        self._verifier = live.verifier
        self._options = live.options
        self._connection = Connection(
            websocket, max_pending=live.options.max_pending_frames, send_timeout=live.options.send_timeout
        )
        self._user_id: str | None = None
        self._expires_at: float | None = None
        self._shows: set[str] = set()
        self._receiving: asyncio.Task[MutableMapping[str, Any]] | None = None
        self._closed: asyncio.Task[bool] | None = None

    async def run(self) -> None:
        connection = self._connection
        sender: asyncio.Task[None] | None = None
        connections_gauge.add(1)
        try:
            with tracer.start_as_current_span("analytics live connect", kind=SpanKind.SERVER) as span:
                span.set_attribute("url.path", PATH)
                await self._websocket.accept()
                sender = asyncio.create_task(connection.run(), name="live-sender")
                self._closed = asyncio.create_task(connection.closed.wait())
                self._hub.connect(connection)
                authenticated = await self._authenticate_first()
                _end_span(span, authenticated, connection)
            if authenticated:
                await self._serve()
        finally:
            self._hub.drop(connection)
            connection.close(protocol.CLOSE_NORMAL, "")
            for task in (self._receiving, self._closed):
                if task is not None:
                    task.cancel()
            if sender is not None:
                await sender
            connections_gauge.add(-1)

    # --------------------------------------------------------- autenticação

    async def _authenticate_first(self) -> bool:
        message = await self._receive(self._options.auth_timeout)
        if message is _Event.TIMEOUT:
            self._close(protocol.CLOSE_AUTH_TIMEOUT, "auth não chegou a tempo")
            return False
        if message is _Event.CLOSED or message["type"] == "websocket.disconnect":
            return False
        try:
            parsed = protocol.parse(message.get("text") or "")
        except BadMessage:
            parsed = None
        if not isinstance(parsed, Auth):
            self._close(protocol.CLOSE_UNAUTHORIZED, "a primeira mensagem deve ser auth")
            return False
        return await self._accept_token(parsed.token)

    async def _accept_token(self, token: str) -> bool:
        try:
            user = await self._verifier.verify(token)
        except ProblemError as error:
            if error.status >= 500:
                self._close(protocol.CLOSE_TRY_AGAIN, "não foi possível validar o token agora")
            else:
                self._close(protocol.CLOSE_UNAUTHORIZED, "token inválido ou expirado")
            return False
        if REQUIRED_ROLE not in user.roles:
            self._close(protocol.CLOSE_FORBIDDEN, "o usuário não tem o papel producer")
            return False
        if self._user_id is not None and user.id != self._user_id:
            self._close(protocol.CLOSE_UNAUTHORIZED, "o token é de outro usuário")
            return False
        self._user_id = user.id
        self._expires_at = user.expires_at
        trace.get_current_span().set_attribute("enduser.id", user.id)
        self._connection.send(Frame(protocol.ready(user.id)))
        return True

    # ----------------------------------------------------------- mensagens

    async def _serve(self) -> None:
        while True:
            timeout = None if self._expires_at is None else max(self._expires_at - time.time(), 0.0)
            message = await self._receive(timeout)
            if message is _Event.TIMEOUT:
                self._close(protocol.CLOSE_UNAUTHORIZED, "o token expirou")
                return
            if message is _Event.CLOSED or message["type"] == "websocket.disconnect":
                return
            text = message.get("text")
            if text is None:
                self._error("bad-request", "Mande mensagens de texto em JSON.")
                continue
            try:
                parsed = protocol.parse(text)
            except BadMessage as error:
                self._error("bad-request", error.detail)
                continue
            match parsed:
                case Auth():
                    with tracer.start_as_current_span("analytics live auth") as span:
                        accepted = await self._accept_token(parsed.token)
                        _end_span(span, accepted, self._connection)
                    if not accepted:
                        return
                case Subscribe():
                    if not await self._subscribe(parsed.show_id):
                        return
                case Unsubscribe():
                    if parsed.show_id in self._shows:
                        self._shows.discard(parsed.show_id)
                        self._hub.unsubscribe(self._connection, parsed.show_id)

    async def _subscribe(self, show_id: str) -> bool:
        """Devolve False quando a conexão precisa ser fechada."""
        with tracer.start_as_current_span(
            "analytics live subscribe", attributes={"lotou.show.id": show_id, "enduser.id": self._user_id or ""}
        ) as span:
            if show_id not in self._shows and len(self._shows) >= self._options.max_subscriptions:
                span.set_attribute("lotou.live.result", "limit")
                limit = self._options.max_subscriptions
                self._error("bad-request", f"No máximo {limit} shows por conexão.", show_id)
                return True
            try:
                owner = await self._hub.producer_of(show_id)
                if owner is None or owner != self._user_id:
                    span.set_attribute("lotou.live.result", "forbidden")
                    self._error("forbidden", "Show não encontrado ou de outro produtor.", show_id)
                    return True
                if show_id in self._shows:
                    # Assinar de novo manda uma foto nova.
                    self._hub.unsubscribe(self._connection, show_id)
                await self._hub.subscribe(self._connection, show_id)
            except Exception as error:
                logger.exception("Falha ao assinar o show no painel", extra={"showId": show_id})
                span.record_exception(error)
                span.set_status(Status(StatusCode.ERROR))
                self._shows.discard(show_id)
                self._close(protocol.CLOSE_TRY_AGAIN, "falha ao montar a foto do show")
                return False
            self._shows.add(show_id)
            span.set_attribute("lotou.live.result", "subscribed")
            return True

    # ------------------------------------------------------------ internos

    async def _receive(self, wait: float | None) -> MutableMapping[str, Any] | _Event:
        """Próxima mensagem do cliente, ou TIMEOUT, ou CLOSED (o servidor pediu o fechamento)."""
        if self._receiving is None:
            self._receiving = asyncio.create_task(self._websocket.receive())
        assert self._closed is not None
        done, _ = await asyncio.wait({self._receiving, self._closed}, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
        if self._receiving in done:
            task, self._receiving = self._receiving, None
            return task.result()
        if self._closed in done:
            return _Event.CLOSED
        return _Event.TIMEOUT

    def _close(self, code: int, reason: str) -> None:
        self._connection.close(code, reason)

    def _error(self, code: protocol.ErrorCode, detail: str, show_id: str | None = None) -> None:
        self._connection.send(Frame(protocol.error(code, detail, show_id)))


def _end_span(span: trace.Span, accepted: bool, connection: Connection) -> None:
    span.set_attribute("lotou.live.authenticated", accepted)
    if connection.close_code is not None:
        span.set_attribute("websocket.close.code", connection.close_code)

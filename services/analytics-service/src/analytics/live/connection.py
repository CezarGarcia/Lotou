"""Fila de envio de um WebSocket do painel.

Quem produz frames (o repasse das métricas e da atividade, que atende todas as
conexões da instância) nunca espera um cliente: só põe o frame na fila desta
conexão e segue. Uma task por conexão envia, e é a única que escreve no socket,
inclusive o fechamento.

Cliente lento:

- **Métricas** são substituíveis: fica só a mais recente de cada show ainda não
  enviada. Um cliente atrasado pula segundos, não acumula.
- **Atividade** (e `snapshot`, `ready`, `error`) nunca é descartada: um buraco
  no feed seria silencioso. Se a fila passa de `max_pending` frames, a conexão
  é fechada com 1013; o cliente reconecta, assina de novo e recebe a foto.
- Um envio que não termina em `send_timeout` (o TCP do cliente parou) também
  fecha a conexão.
"""

import asyncio
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from opentelemetry import metrics

from analytics.live.protocol import CLOSE_TRY_AGAIN

logger = logging.getLogger(__name__)
meter = metrics.get_meter("analytics-service")

event_delay = meter.create_histogram(
    "dashboard_event_delay_seconds",
    unit="s",
    description="Do occurredAt do fato ao envio do frame activity ao painel (critério da fase 4: menos de 2 s)",
    explicit_bucket_boundaries_advisory=[0.05, 0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0, 10.0, 30.0],
)


# Registro interno de que o cliente fechou ou caiu; não é enviado (o socket já foi).
CLOSE_ABNORMAL = 1006


class WebSocketLike(Protocol):
    async def send_text(self, data: str) -> None: ...

    async def close(self, code: int = 1000, reason: str | None = None) -> None: ...


@dataclass(frozen=True)
class Frame:
    text: str
    show_id: str | None = None
    # Hora do fato, nos frames `activity`: mede o atraso até o envio.
    occurred_at: datetime | None = None
    event_type: str | None = None


class Connection:
    def __init__(
        self,
        websocket: WebSocketLike,
        *,
        max_pending: int = 500,
        send_timeout: float = 10.0,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._websocket = websocket
        self._max_pending = max_pending
        self._send_timeout = send_timeout
        self._clock = clock
        self._ordered: deque[Frame] = deque()
        self._metrics: dict[str, Frame] = {}
        self._wake = asyncio.Event()
        self._close: tuple[int, str] | None = None
        self.closed = asyncio.Event()

    @property
    def closing(self) -> bool:
        return self._close is not None

    @property
    def close_code(self) -> int | None:
        return self._close[0] if self._close else None

    @property
    def pending(self) -> int:
        return len(self._ordered) + len(self._metrics)

    def send(self, frame: Frame) -> None:
        """Frame que não pode ser descartado. Fila cheia fecha a conexão (1013)."""
        if self._close is not None:
            return
        if len(self._ordered) >= self._max_pending:
            logger.warning("Cliente do painel lento demais; fechando a conexão", extra={"pending": self.pending})
            self.close(CLOSE_TRY_AGAIN, "cliente lento: a fila de envio encheu")
            return
        self._ordered.append(frame)
        self._wake.set()

    def send_metrics(self, show_id: str, frame: Frame) -> None:
        """Métricas do show: substitui a que ainda não foi enviada."""
        if self._close is not None:
            return
        self._metrics.pop(show_id, None)
        self._metrics[show_id] = frame
        self._wake.set()

    def forget(self, show_id: str) -> None:
        """Descarta o que está na fila de um show (depois do `unsubscribe`)."""
        self._metrics.pop(show_id, None)
        self._ordered = deque(frame for frame in self._ordered if frame.show_id != show_id)

    def close(self, code: int, reason: str) -> None:
        """Pede o fechamento; o que ainda está na fila é descartado."""
        if self._close is None:
            self._close = (code, reason)
            self._wake.set()

    async def run(self) -> None:
        """Envia até o fechamento (pedido aqui ou pelo cliente). Termina com `closed` marcado."""
        try:
            while True:
                await self._wake.wait()
                self._wake.clear()
                while self._close is None and (frame := self._next()) is not None:
                    await self._timed(self._websocket.send_text(frame.text))
                    if frame.occurred_at is not None:
                        delay = max(self._clock() - frame.occurred_at.timestamp(), 0.0)
                        event_delay.record(delay, {"type": frame.event_type or "unknown"})
                if self._close is not None:
                    code, reason = self._close
                    with suppress(Exception):
                        await self._timed(self._websocket.close(code, reason))
                    return
        except TimeoutError:
            logger.warning("Envio ao painel parado; fechando a conexão")
            self._close = self._close or (CLOSE_TRY_AGAIN, "envio parado")
            with suppress(Exception):
                await asyncio.wait_for(self._websocket.close(*self._close), timeout=1.0)
        except Exception:
            # O cliente foi embora no meio do envio: nada a fazer além de parar.
            logger.debug("Envio ao painel interrompido", exc_info=True)
            self._close = self._close or (CLOSE_ABNORMAL, "cliente desconectou")
        finally:
            self.closed.set()

    def _next(self) -> Frame | None:
        if self._ordered:
            return self._ordered.popleft()
        if self._metrics:
            show_id = next(iter(self._metrics))
            return self._metrics.pop(show_id)
        return None

    async def _timed(self, operation: Awaitable[None]) -> None:
        await asyncio.wait_for(operation, timeout=self._send_timeout)

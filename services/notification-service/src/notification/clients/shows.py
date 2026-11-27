"""Dados do show para o ingresso e os e-mails, pela API pública do event-service.

`GET {EVENT_SERVICE_URL}/v1/shows/{id}`, guardado em memória por pouco tempo
(`SHOW_CACHE_SECONDS`): os ingressos de uma abertura de vendas são quase todos
do mesmo show, e uma consulta por pedido seria carga à toa no event-service.
Se o título ou a data mudarem, o PDF seguinte já sai certo depois do prazo.
"""

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import ValidationError

from notification.render.formatting import FALLBACK_TIMEZONE
from notification.tasks import ShowInfo


class ShowNotFound(Exception):
    """O event-service não conhece o show. Repetir não muda: o PDF vai para a DLQ."""


class ShowsUnavailable(Exception):
    """O event-service não respondeu como devia (fora do ar, 5xx, 429). Tentar de novo resolve."""


@dataclass(frozen=True, slots=True)
class _Entry:
    show: ShowInfo
    expires_at: float


class ShowDirectory:
    def __init__(self, base_url: str, http: httpx.AsyncClient, *, ttl_seconds: float = 60.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._http = http
        self._ttl = ttl_seconds
        self._cache: dict[str, _Entry] = {}
        self._lock = asyncio.Lock()

    async def get(self, show_id: str) -> ShowInfo:
        entry = self._cache.get(show_id)
        if entry is not None and entry.expires_at > time.monotonic():
            return entry.show
        show = await self._fetch(show_id)
        async with self._lock:
            if len(self._cache) > 1000:
                now = time.monotonic()
                self._cache = {key: value for key, value in self._cache.items() if value.expires_at > now}
            self._cache[show_id] = _Entry(show, time.monotonic() + self._ttl)
        return show

    async def _fetch(self, show_id: str) -> ShowInfo:
        url = f"{self._base_url}/v1/shows/{quote(show_id, safe='')}"
        try:
            response = await self._http.get(url, timeout=5.0, headers={"Accept": "application/json"})
        except httpx.HTTPError as error:
            raise ShowsUnavailable(f"event-service não respondeu: {type(error).__name__}") from error
        if response.status_code == httpx.codes.NOT_FOUND:
            raise ShowNotFound(f"show {show_id} não existe no event-service")
        if response.status_code != httpx.codes.OK:
            raise ShowsUnavailable(f"event-service respondeu {response.status_code}")
        try:
            return to_show_info(response.json())
        except (ValueError, ValidationError, KeyError, TypeError) as error:
            raise ShowsUnavailable(f"resposta do event-service fora do formato: {error}") from error


def to_show_info(body: dict[str, Any]) -> ShowInfo:
    venue = body.get("venue") or {}
    return ShowInfo(
        title=body["title"],
        artist=body["artist"],
        starts_at=datetime.fromisoformat(body["startsAt"]),
        timezone=venue.get("timezone") or FALLBACK_TIMEZONE,
        venue_name=venue.get("name"),
        venue_city=venue.get("city"),
        venue_state=venue.get("state"),
    )

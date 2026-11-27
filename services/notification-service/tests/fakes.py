"""O event-service e a API de administração do Keycloak, servidos sem rede.

Não são banco nem broker: são as duas APIs HTTP que o serviço consulta, e o que
os testes precisam delas é controlar a resposta (show que não existe, Keycloak
fora do ar, comprador sem e-mail) e contar as chamadas.
"""

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

from notification.ids import uuid7

EVENT_SERVICE_URL = "http://event-service.test"
KEYCLOAK_URL = "http://keycloak.test"
CLIENT_ID = "notification-service"
CLIENT_SECRET = "segredo-de-teste"


def show_body(
    show_id: str,
    *,
    title: str = "Noite de Teste",
    artist: str = "Banda Fictícia",
    starts_at: str = "2026-12-13T00:00:00.000Z",
    timezone: str = "America/Sao_Paulo",
) -> dict[str, Any]:
    """Como o event-service responde `GET /v1/shows/{id}` (`show.response.ts`)."""
    return {
        "id": show_id,
        "title": title,
        "artist": artist,
        "status": "ON_SALE",
        "startsAt": starts_at,
        "salesStartAt": "2026-11-01T12:00:00.000Z",
        "highDemand": False,
        "venue": {
            "id": uuid7(),
            "name": "Arena Lotou",
            "city": "São Paulo",
            "state": "SP",
            "timezone": timezone,
        },
        "priceFromCents": 16000,
        "description": "Show de teste",
        "doorsOpenAt": None,
        "salesEndAt": None,
        "sectors": [],
        "publishedAt": "2026-11-01T12:00:00.000Z",
        "version": 3,
        "createdAt": "2026-11-01T12:00:00.000Z",
        "updatedAt": "2026-11-01T12:00:00.000Z",
    }


@dataclass
class FakeBackends:
    shows: dict[str, dict[str, Any]] = field(default_factory=dict)
    users: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Quando ligados, respondem 503 (fora do ar).
    event_service_down: bool = False
    keycloak_down: bool = False
    show_calls: int = 0
    user_calls: int = 0
    token_calls: int = 0
    issued_tokens: set[str] = field(default_factory=set)

    def add_show(self, **kwargs: Any) -> str:
        show_id = uuid7()
        self.shows[show_id] = show_body(show_id, **kwargs)
        return show_id

    def add_buyer(self, *, email: str | None = "comprador@lotou.test", first_name: str | None = "Bia") -> str:
        buyer_id = str(uuid.uuid4())
        user: dict[str, Any] = {"id": buyer_id, "username": f"user-{buyer_id[:8]}", "enabled": True}
        if email is not None:
            user["email"] = email
        if first_name is not None:
            user["firstName"] = first_name
        self.users[buyer_id] = user
        return buyer_id

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self._handle))

    def _handle(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.startswith(EVENT_SERVICE_URL):
            return self._event_service(request)
        if url.startswith(KEYCLOAK_URL):
            return self._keycloak(request)
        return httpx.Response(404)

    def _event_service(self, request: httpx.Request) -> httpx.Response:
        self.show_calls += 1
        if self.event_service_down:
            return httpx.Response(503, json={"type": "about:blank", "status": 503})
        show_id = request.url.path.removeprefix("/v1/shows/")
        show = self.shows.get(show_id)
        if show is None:
            return httpx.Response(404, json={"type": "urn:lotou:problem:not-found", "status": 404})
        return httpx.Response(200, content=json.dumps(show).encode(), headers={"content-type": "application/json"})

    def _keycloak(self, request: httpx.Request) -> httpx.Response:
        if self.keycloak_down:
            return httpx.Response(503)
        path = request.url.path
        if path == "/realms/lotou/protocol/openid-connect/token":
            self.token_calls += 1
            expected = httpx.BasicAuth(CLIENT_ID, CLIENT_SECRET)._auth_header
            if request.headers.get("authorization") != expected:
                return httpx.Response(401, json={"error": "unauthorized_client"})
            token = uuid.uuid4().hex
            self.issued_tokens.add(token)
            return httpx.Response(200, json={"access_token": token, "expires_in": 300, "token_type": "Bearer"})
        if path.startswith("/admin/realms/lotou/users/"):
            self.user_calls += 1
            token = request.headers.get("authorization", "").removeprefix("Bearer ")
            if token not in self.issued_tokens:
                return httpx.Response(401)
            user = self.users.get(path.rsplit("/", 1)[-1])
            if user is None:
                return httpx.Response(404, json={"error": "User not found"})
            return httpx.Response(200, json=user)
        return httpx.Response(404)

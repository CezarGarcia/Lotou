"""Mensagens do WebSocket do painel (`contracts/realtime-dashboard.md`).

Do cliente chegam `auth`, `subscribe` e `unsubscribe`; cada uma é validada aqui
antes de qualquer efeito. Do servidor saem `ready`, `snapshot`, `metrics`,
`activity` e `error`, montadas aqui como texto JSON.
"""

import json
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, ValidationError
from pydantic.alias_generators import to_camel

# Fechamentos (o cliente decide pelo código se renova o token ou só reconecta).
CLOSE_NORMAL = 1000
CLOSE_GOING_AWAY = 1001
# Tente mais tarde: cliente lento demais (a fila de envio encheu) ou falha
# temporária do servidor (chaves do Keycloak, Redis ou MongoDB fora).
CLOSE_TRY_AGAIN = 1013
CLOSE_UNAUTHORIZED = 4401
CLOSE_FORBIDDEN = 4403
CLOSE_AUTH_TIMEOUT = 4408

# Uma mensagem do cliente é pequena: o token é a maior parte.
MAX_CLIENT_MESSAGE = 16 * 1024

Uuid = Annotated[
    str,
    StringConstraints(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
]


class _ClientMessage(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, frozen=True, extra="ignore")


class Auth(_ClientMessage):
    type: Literal["auth"]
    token: Annotated[str, StringConstraints(min_length=1, max_length=8192)]


class Subscribe(_ClientMessage):
    type: Literal["subscribe"]
    show_id: Uuid


class Unsubscribe(_ClientMessage):
    type: Literal["unsubscribe"]
    show_id: Uuid


ClientMessage = Auth | Subscribe | Unsubscribe
_client_message: TypeAdapter[ClientMessage] = TypeAdapter(Annotated[ClientMessage, Field(discriminator="type")])


class BadMessage(ValueError):
    """Mensagem do cliente fora do protocolo; `detail` vai na resposta `error`."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


def parse(text: str) -> ClientMessage:
    if len(text) > MAX_CLIENT_MESSAGE:
        raise BadMessage("Mensagem grande demais.")
    try:
        raw = json.loads(text)
    except ValueError:
        raise BadMessage("A mensagem não é JSON válido.") from None
    if not isinstance(raw, dict):
        raise BadMessage("A mensagem deve ser um objeto JSON.")
    if raw.get("type") not in ("auth", "subscribe", "unsubscribe"):
        raise BadMessage("Tipo de mensagem desconhecido: use auth, subscribe ou unsubscribe.")
    try:
        return _client_message.validate_python(raw)
    except ValidationError as error:
        fields = ", ".join(".".join(str(part) for part in item["loc"][1:]) or "type" for item in error.errors())
        raise BadMessage(f"Campos inválidos: {fields}.") from None


# ------------------------------------------------------------- servidor


def iso(at: datetime) -> str:
    """Data em UTC no formato do resto da API: `2026-11-26T18:00:01Z`, com milissegundos se houver."""
    utc = at.astimezone(UTC)
    text = utc.strftime("%Y-%m-%dT%H:%M:%S")
    if utc.microsecond:
        text += f".{utc.microsecond // 1000:03d}"
    return text + "Z"


def _dumps(value: dict[str, Any]) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def ready(user_id: str) -> str:
    return _dumps({"type": "ready", "user": user_id})


def snapshot(show_id: str, metrics: dict[str, Any] | None, activity: list[dict[str, Any]]) -> str:
    return _dumps({"type": "snapshot", "showId": show_id, "metrics": metrics, "activity": activity})


def metrics(show_id: str, value: dict[str, Any]) -> str:
    return _dumps({"type": "metrics", "showId": show_id, "metrics": value})


def activity(show_id: str, entry: dict[str, Any]) -> str:
    return _dumps({"type": "activity", "showId": show_id, "entry": entry})


ErrorCode = Literal["forbidden", "bad-request"]


def error(code: ErrorCode, detail: str, show_id: str | None = None) -> str:
    body: dict[str, Any] = {"type": "error", "code": code, "detail": detail}
    if show_id is not None:
        body["showId"] = show_id
    return _dumps(body)

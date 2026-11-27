"""WebSocket do painel sem Redis nem MongoDB: autenticação, códigos de fechamento e mensagens.

O hub é de mentira; o token passa pela validação de verdade, com o JWKS do
Keycloak de mentira, e o WebSocket é o do uvicorn, numa porta local.
"""

import asyncio
import time
from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi import FastAPI

from analytics.api.auth import JwksCache, TokenVerifier
from analytics.live import endpoint, protocol
from analytics.live.connection import Connection, Frame
from analytics.live.endpoint import Live, LiveOptions
from tests.live_client import LiveClient, serve
from tests.tokens import AUDIENCE, ISSUER, JWKS_URI, FakeKeycloak

PRODUCER = "produtor-1"
MINE = "01a21a00-0000-7000-8000-000000000001"
THEIRS = "01a21a00-0000-7000-8000-000000000002"


class FakeHub:
    def __init__(self) -> None:
        self.owners = {MINE: PRODUCER, THEIRS: "outro-produtor"}
        self.subscribed: list[str] = []
        self.connected = 0
        self.dropped = 0

    def connect(self, connection: Connection) -> None:
        self.connected += 1

    def drop(self, connection: Connection) -> None:
        self.dropped += 1

    async def subscribe(self, connection: Connection, show_id: str) -> None:
        self.subscribed.append(show_id)
        connection.send(Frame(protocol.snapshot(show_id, None, []), show_id))

    def unsubscribe(self, connection: Connection, show_id: str) -> None:
        self.subscribed.remove(show_id)

    async def producer_of(self, show_id: str) -> str | None:
        return self.owners.get(show_id)


@pytest.fixture
def keycloak() -> FakeKeycloak:
    return FakeKeycloak()


@pytest.fixture
def hub() -> FakeHub:
    return FakeHub()


@pytest.fixture
async def url(keycloak: FakeKeycloak, hub: FakeHub) -> AsyncIterator[str]:
    app = FastAPI()
    app.include_router(endpoint.router)
    verifier = TokenVerifier(JwksCache(JWKS_URI, keycloak.http_client()), issuer=ISSUER, audience=AUDIENCE)
    app.state.live = Live(
        hub=hub, verifier=verifier, options=LiveOptions(auth_timeout=0.3, max_subscriptions=2, send_timeout=1.0)
    )
    server = await serve(app, lifespan="off")
    yield server.url(endpoint.PATH)
    await server.stop()


async def connect(url: str) -> LiveClient:
    return await LiveClient.open(url)


async def reply(client: LiveClient, **message: Any) -> dict[str, Any]:
    """Manda e devolve o próximo frame."""
    mark = client.mark()
    await client.send(**message)
    return (await client.wait_for(lambda _: True, since=mark, within=3)).frame


async def test_auth_then_subscribe(url: str, keycloak: FakeKeycloak, hub: FakeHub) -> None:
    client = await connect(url)
    assert await client.auth(keycloak.token(PRODUCER, ["producer"])) == {"type": "ready", "user": PRODUCER}
    snapshot = await client.subscribe(MINE)
    assert (snapshot["type"], snapshot["showId"]) == ("snapshot", MINE)
    await client.send(type="unsubscribe", showId=MINE)
    # A mensagem seguinte só é lida depois do unsubscribe.
    assert (await reply(client, type="ping"))["code"] == "bad-request"
    assert hub.subscribed == []
    await client.close()
    await asyncio.sleep(0.05)
    assert (hub.connected, hub.dropped) == (1, 1)


async def test_no_auth_in_time_closes_with_4408(url: str) -> None:
    client = await connect(url)
    assert await client.wait_closed(within=2) == 4408


@pytest.mark.parametrize(
    "first",
    [
        {"type": "subscribe", "showId": MINE},
        {"type": "auth"},
        "não é json",
    ],
)
async def test_first_message_must_be_auth(url: str, first: Any) -> None:
    client = await connect(url)
    if isinstance(first, str):
        await client.ws.send(first)
    else:
        await client.send(**first)
    assert await client.wait_closed(within=2) == 4401


@pytest.mark.parametrize(
    ("token_kwargs", "roles", "code"),
    [
        ({"expires_in": -10}, ["producer"], 4401),
        ({"audience": "outra-api"}, ["producer"], 4401),
        ({"issuer": "http://outro/realms/lotou"}, ["producer"], 4401),
        ({}, ["buyer"], 4403),
        ({}, [], 4403),
    ],
)
async def test_bad_tokens_close_the_connection(
    url: str, keycloak: FakeKeycloak, token_kwargs: dict[str, Any], roles: list[str], code: int
) -> None:
    client = await connect(url)
    await client.send(type="auth", token=keycloak.token(PRODUCER, roles, **token_kwargs))
    assert await client.wait_closed(within=2) == code


async def test_keycloak_down_closes_with_try_again(url: str, keycloak: FakeKeycloak) -> None:
    keycloak.down = True
    client = await connect(url)
    await client.send(type="auth", token=keycloak.token(PRODUCER, ["producer"]))
    assert await client.wait_closed(within=2) == 1013


async def test_token_expiring_without_refresh_closes_with_4401(url: str, keycloak: FakeKeycloak) -> None:
    client = await connect(url)
    await client.auth(keycloak.token(PRODUCER, ["producer"], expires_in=1))
    started = time.monotonic()
    assert await client.wait_closed(within=3) == 4401
    assert time.monotonic() - started < 2


async def test_refreshed_token_keeps_the_connection(url: str, keycloak: FakeKeycloak) -> None:
    client = await connect(url)
    await client.auth(keycloak.token(PRODUCER, ["producer"], expires_in=1))
    assert await client.auth(keycloak.token(PRODUCER, ["producer"])) == {"type": "ready", "user": PRODUCER}
    await asyncio.sleep(2.1)
    assert (await client.subscribe(MINE))["type"] == "snapshot"
    await client.close()


async def test_refresh_with_another_users_token_closes(url: str, keycloak: FakeKeycloak) -> None:
    client = await connect(url)
    await client.auth(keycloak.token(PRODUCER, ["producer"]))
    await client.send(type="auth", token=keycloak.token("outro", ["producer"]))
    assert await client.wait_closed(within=2) == 4401


async def test_subscribe_only_to_own_shows(url: str, keycloak: FakeKeycloak, hub: FakeHub) -> None:
    unknown = "01a21a00-0000-7000-8000-000000000003"
    client = await connect(url)
    await client.auth(keycloak.token(PRODUCER, ["producer"]))
    for show_id in (THEIRS, unknown):
        assert await client.subscribe(show_id) == {
            "type": "error",
            "code": "forbidden",
            "detail": "Show não encontrado ou de outro produtor.",
            "showId": show_id,
        }
    bad = await reply(client, type="subscribe", showId="nao-e-uuid")
    assert (bad["code"], bad["detail"]) == ("bad-request", "Campos inválidos: showId.")
    mark = client.mark()
    await client.ws.send(b"\x00")
    assert (await client.wait_for(lambda _: True, since=mark)).frame["code"] == "bad-request"
    assert (await client.subscribe(MINE))["type"] == "snapshot"
    assert hub.subscribed == [MINE]
    await client.close()


async def test_subscriptions_per_connection_are_limited(url: str, keycloak: FakeKeycloak, hub: FakeHub) -> None:
    other = "01a21a00-0000-7000-8000-000000000004"
    third = "01a21a00-0000-7000-8000-000000000005"
    hub.owners |= {other: PRODUCER, third: PRODUCER}
    client = await connect(url)
    await client.auth(keycloak.token(PRODUCER, ["producer"]))
    assert (await client.subscribe(MINE))["type"] == "snapshot"
    assert (await client.subscribe(other))["type"] == "snapshot"
    limited = await client.subscribe(third)
    assert (limited["code"], limited["showId"]) == ("bad-request", third)
    # Assinar de novo o mesmo show não conta no limite e manda outra foto.
    assert (await client.subscribe(MINE))["type"] == "snapshot"
    assert sorted(hub.subscribed) == sorted([other, MINE])
    await client.close()

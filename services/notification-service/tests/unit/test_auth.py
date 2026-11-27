"""Validação do JWT (ADR 21) e as respostas 401 e 403 em Problem Details."""

from collections.abc import AsyncIterator
from typing import Annotated

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import Depends, FastAPI

from notification.api import problems
from notification.api.auth import JwksCache, TokenVerifier, User, require_role
from notification.api.problems import ProblemError
from tests.tokens import AUDIENCE, ISSUER, JWKS_URI, FakeKeycloak


@pytest.fixture
async def keycloak() -> FakeKeycloak:
    return FakeKeycloak()


@pytest.fixture
async def verifier(keycloak: FakeKeycloak) -> AsyncIterator[TokenVerifier]:
    async with keycloak.http_client() as http:
        yield TokenVerifier(JwksCache(JWKS_URI, http, refresh_interval=60), issuer=ISSUER, audience=AUDIENCE)


async def test_valid_token_gives_the_user_and_realm_roles(keycloak: FakeKeycloak, verifier: TokenVerifier) -> None:
    user = await verifier.verify(keycloak.token("produtor-1", ["producer", "offline_access", "uma_authorization"]))
    assert user == User(id="produtor-1", roles=frozenset({"producer"}))


async def test_keys_are_cached(keycloak: FakeKeycloak, verifier: TokenVerifier) -> None:
    for _ in range(3):
        await verifier.verify(keycloak.token("produtor-1", ["producer"]))
    assert keycloak.jwks_calls == 1


async def test_unknown_kid_refreshes_the_keys_once(keycloak: FakeKeycloak) -> None:
    async with keycloak.http_client() as http:
        verifier = TokenVerifier(JwksCache(JWKS_URI, http, refresh_interval=0), issuer=ISSUER, audience=AUDIENCE)
        await verifier.verify(keycloak.token("produtor-1", ["producer"]))
        keycloak.rotate()  # o Keycloak passa a assinar com uma chave nova
        user = await verifier.verify(keycloak.token("produtor-1", ["producer"]))
    assert user.id == "produtor-1"
    assert keycloak.jwks_calls == 2


async def test_refresh_for_unknown_kid_is_rate_limited(keycloak: FakeKeycloak, verifier: TokenVerifier) -> None:
    await verifier.verify(keycloak.token("produtor-1", ["producer"]))
    for _ in range(5):
        with pytest.raises(ProblemError) as raised:
            await verifier.verify(
                keycloak.token("x", ["producer"], kid="kid-forjado", key=keycloak.keys[keycloak.current_kid])
            )
        assert raised.value.status == 401
    assert keycloak.jwks_calls == 1


@pytest.mark.parametrize(
    ("kwargs", "detail"),
    [
        ({"expires_in": -60}, "O token expirou."),
        ({"audience": "outra-api"}, "O token é inválido."),
        ({"issuer": "http://evil.test/realms/lotou"}, "O token é inválido."),
    ],
    ids=["expirado", "audiencia", "emissor"],
)
async def test_invalid_claims_are_rejected(
    keycloak: FakeKeycloak, verifier: TokenVerifier, kwargs: dict, detail: str
) -> None:
    with pytest.raises(ProblemError) as raised:
        await verifier.verify(keycloak.token("produtor-1", ["producer"], **kwargs))
    assert (raised.value.status, raised.value.detail) == (401, detail)


async def test_token_signed_with_another_key_is_rejected(keycloak: FakeKeycloak, verifier: TokenVerifier) -> None:
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with pytest.raises(ProblemError) as raised:
        await verifier.verify(keycloak.token("produtor-1", ["producer"], key=other))
    assert raised.value.status == 401


@pytest.mark.parametrize("token", ["", "abc", "a.b.c", "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0."])
async def test_garbage_is_rejected(verifier: TokenVerifier, token: str) -> None:
    with pytest.raises(ProblemError) as raised:
        await verifier.verify(token)
    assert raised.value.status == 401


async def test_keycloak_down_is_503_not_401(keycloak: FakeKeycloak, verifier: TokenVerifier) -> None:
    keycloak.down = True
    with pytest.raises(ProblemError) as raised:
        await verifier.verify(keycloak.token("produtor-1", ["producer"]))
    assert raised.value.status == 503


# ------------------------------------------------------------------ HTTP


@pytest.fixture
async def client(keycloak: FakeKeycloak, verifier: TokenVerifier) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    problems.install(app)
    app.state.token_verifier = verifier

    @app.get("/producer-only")
    async def producer_only(user: Annotated[User, Depends(require_role("producer"))]) -> dict[str, str]:
        return {"id": user.id}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as http:
        yield http


async def test_route_with_role(keycloak: FakeKeycloak, client: httpx.AsyncClient) -> None:
    response = await client.get("/producer-only", headers=keycloak.bearer("produtor-1", ["producer"]))
    assert response.status_code == 200
    assert response.json() == {"id": "produtor-1"}


@pytest.mark.parametrize(
    ("headers", "detail"),
    [
        ({}, "Envie o token no cabeçalho Authorization."),
        ({"Authorization": "Basic dXNlcjpwYXNz"}, "O cabeçalho Authorization deve usar o esquema Bearer."),
        ({"Authorization": "Bearer"}, "O cabeçalho Authorization deve usar o esquema Bearer."),
    ],
)
async def test_missing_or_malformed_authorization_is_401(
    client: httpx.AsyncClient, headers: dict[str, str], detail: str
) -> None:
    response = await client.get("/producer-only", headers=headers)
    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.headers["www-authenticate"] == "Bearer"
    body = response.json()
    assert body["type"] == "urn:lotou:problem:unauthorized"
    assert body["detail"] == detail
    assert body["instance"] == "/producer-only"


async def test_user_without_the_role_is_403(keycloak: FakeKeycloak, client: httpx.AsyncClient) -> None:
    response = await client.get("/producer-only", headers=keycloak.bearer("comprador-1", ["buyer"]))
    assert response.status_code == 403
    assert response.json()["type"] == "urn:lotou:problem:forbidden"

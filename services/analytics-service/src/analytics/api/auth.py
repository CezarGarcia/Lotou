"""Validação do JWT do Keycloak (ADR 21: o serviço revalida o token que o gateway já validou).

Confere assinatura (chave pública do realm, via JWKS), emissor, audiência e
validade. A validação é local: as chaves ficam em cache e só são buscadas de
novo quando aparece um `kid` desconhecido (rotação de chaves), no máximo uma vez
a cada `refresh_interval`, para um token forjado com `kid` aleatório não virar
uma enxurrada de chamadas ao Keycloak.

Toda rota exige autenticação por padrão; o papel exigido é declarado na rota com
`require_role`. O ID do usuário vem do claim `sub` e os papéis de
`realm_access.roles`.
"""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, Request
from jwt import PyJWK, PyJWKSet

from analytics.api import problems

logger = logging.getLogger(__name__)

ROLES = frozenset({"buyer", "producer", "gate-staff", "service"})


@dataclass(frozen=True)
class User:
    id: str
    roles: frozenset[str]
    # `exp` do token (epoch em segundos): o WebSocket do painel fecha quando ele vence.
    expires_at: float | None = field(default=None, compare=False)


class KeySetUnavailable(Exception):
    """Não foi possível baixar as chaves públicas (Keycloak fora do ar)."""


class JwksCache:
    def __init__(self, uri: str, http: httpx.AsyncClient, *, refresh_interval: float = 30.0) -> None:
        self._uri = uri
        self._http = http
        self._refresh_interval = refresh_interval
        self._keys: dict[str, PyJWK] = {}
        self._fetched_at: float | None = None
        self._lock = asyncio.Lock()

    async def key(self, kid: str) -> PyJWK | None:
        if kid in self._keys:
            return self._keys[kid]
        async with self._lock:
            if kid not in self._keys and self._may_refresh():
                await self._refresh()
        return self._keys.get(kid)

    def _may_refresh(self) -> bool:
        return self._fetched_at is None or time.monotonic() - self._fetched_at >= self._refresh_interval

    async def _refresh(self) -> None:
        try:
            response = await self._http.get(self._uri, timeout=5.0)
            response.raise_for_status()
            key_set = PyJWKSet.from_dict(response.json())
        except (httpx.HTTPError, ValueError, jwt.PyJWKError) as error:
            raise KeySetUnavailable(str(error)) from error
        self._keys = {key.key_id: key for key in key_set.keys if key.key_id}
        self._fetched_at = time.monotonic()


class TokenVerifier:
    def __init__(self, keys: JwksCache, *, issuer: str, audience: str) -> None:
        self._keys = keys
        self._issuer = issuer
        self._audience = audience

    async def verify(self, token: str) -> User:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError:
            raise problems.unauthorized("O token é inválido.") from None
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not isinstance(kid, str):
            raise problems.unauthorized("O token é inválido.")
        try:
            key = await self._keys.key(kid)
        except KeySetUnavailable:
            logger.warning("Não foi possível baixar as chaves públicas do Keycloak", exc_info=True)
            raise problems.unavailable("Não foi possível validar o token agora.") from None
        if key is None:
            raise problems.unauthorized("O token é inválido.")
        try:
            claims: dict[str, Any] = jwt.decode(
                token,
                key.key,
                algorithms=["RS256"],
                audience=self._audience,
                issuer=self._issuer,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        except jwt.ExpiredSignatureError:
            raise problems.unauthorized("O token expirou.") from None
        except jwt.InvalidTokenError:
            raise problems.unauthorized("O token é inválido.") from None
        realm_access = claims.get("realm_access")
        raw_roles = realm_access.get("roles") if isinstance(realm_access, dict) else None
        roles = frozenset(role for role in raw_roles or [] if role in ROLES)
        return User(id=str(claims["sub"]), roles=roles, expires_at=float(claims["exp"]))


def _bearer_token(request: Request) -> str:
    authorization = request.headers.get("authorization")
    if not authorization:
        raise problems.unauthorized("Envie o token no cabeçalho Authorization.")
    scheme, _, token = authorization.partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token or " " in token:
        raise problems.unauthorized("O cabeçalho Authorization deve usar o esquema Bearer.")
    return token


async def current_user(request: Request) -> User:
    verifier: TokenVerifier = request.app.state.token_verifier
    return await verifier.verify(_bearer_token(request))


def require_role(role: str) -> Callable[[User], Awaitable[User]]:
    async def dependency(user: Annotated[User, Depends(current_user)]) -> User:
        if role not in user.roles:
            raise problems.forbidden()
        return user

    return dependency

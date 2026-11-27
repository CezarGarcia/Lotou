"""Um Keycloak de mentira: par de chaves RSA, JWKS servido sem rede e tokens assinados."""

import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

ISSUER = "http://localhost:8180/realms/lotou"
JWKS_URI = "http://keycloak.test/realms/lotou/protocol/openid-connect/certs"
AUDIENCE = "lotou-api"


@dataclass
class FakeKeycloak:
    keys: dict[str, rsa.RSAPrivateKey] = field(default_factory=dict)
    jwks_calls: int = 0
    down: bool = False

    def __post_init__(self) -> None:
        if not self.keys:
            self.rotate()

    def rotate(self) -> str:
        kid = uuid.uuid4().hex
        self.keys[kid] = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        return kid

    @property
    def current_kid(self) -> str:
        return list(self.keys)[-1]

    def jwks(self) -> dict[str, Any]:
        result = []
        for kid, key in self.keys.items():
            jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
            result.append({**jwk, "kid": kid, "use": "sig", "alg": "RS256"})
        return {"keys": result}

    def http_client(self) -> httpx.AsyncClient:
        def handler(request: httpx.Request) -> httpx.Response:
            self.jwks_calls += 1
            if self.down:
                return httpx.Response(503)
            return httpx.Response(200, json=self.jwks())

        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    def token(
        self,
        sub: str,
        roles: list[str],
        *,
        audience: str = AUDIENCE,
        issuer: str = ISSUER,
        expires_in: int = 300,
        kid: str | None = None,
        key: rsa.RSAPrivateKey | None = None,
    ) -> str:
        now = int(time.time())
        claims = {
            "sub": sub,
            "iss": issuer,
            "aud": audience,
            "iat": now,
            "exp": now + expires_in,
            "realm_access": {"roles": roles},
        }
        kid = kid or self.current_kid
        return jwt.encode(claims, key or self.keys[kid], algorithm="RS256", headers={"kid": kid})

    def bearer(self, sub: str, roles: list[str]) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token(sub, roles)}"}

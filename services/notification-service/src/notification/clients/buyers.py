"""E-mail e nome do comprador, pela API de administração do Keycloak.

Os eventos só levam o `buyerId` (o `sub` do token); o e-mail fica no Keycloak,
que é onde o comprador o cadastrou e o mantém. O serviço entra com a conta de
serviço `notification-service` (client credentials), que tem só o papel
`view-users` do cliente `realm-management`, e lê
`GET /admin/realms/lotou/users/{id}`.

- O token da conta de serviço (`service_token.py`) fica em memória até perto
  de vencer; um 401 busca outro uma vez.
- A consulta fica em cache por pouco tempo (`BUYER_CACHE_SECONDS`): um pedido
  com e-mail de cancelamento e de ingresso consulta uma vez só.
- Usuário que não existe ou sem e-mail (as contas de serviço do smoke e dos
  testes de carga compram sem ter e-mail) devolve um comprador sem endereço:
  quem chama confirma a mensagem sem tentar de novo.

O endereço só existe na memória deste processo: não vai para log, span,
métrica nem chave do Redis.
"""

import time
from dataclasses import dataclass
from urllib.parse import quote

import httpx

from notification.clients.service_token import ServiceAccountToken, TokenUnavailable


@dataclass(frozen=True, slots=True)
class Buyer:
    id: str
    email: str | None
    first_name: str | None

    def __repr__(self) -> str:  # o e-mail não aparece nem num traceback
        return f"Buyer(id={self.id!r}, email={'<oculto>' if self.email else None})"


class BuyersUnavailable(Exception):
    """O Keycloak não respondeu como devia. Tentar de novo resolve."""


@dataclass(frozen=True, slots=True)
class _Cached:
    buyer: Buyer
    expires_at: float


class BuyerDirectory:
    def __init__(
        self,
        *,
        token_url: str,
        admin_url: str,
        client_id: str,
        client_secret: str,
        http: httpx.AsyncClient,
        ttl_seconds: float = 300.0,
        max_entries: int = 10_000,
        tokens: ServiceAccountToken | None = None,
    ) -> None:
        self._admin_url = admin_url.rstrip("/")
        self._http = http
        self._ttl = ttl_seconds
        self._max_entries = max_entries
        self._cache: dict[str, _Cached] = {}
        # O mesmo token serve o analytics: quem monta o serviço passa um só.
        self._tokens = tokens or ServiceAccountToken(
            token_url=token_url, client_id=client_id, client_secret=client_secret, http=http
        )

    async def get(self, buyer_id: str) -> Buyer:
        cached = self._cache.get(buyer_id)
        if cached is not None and cached.expires_at > time.monotonic():
            return cached.buyer
        buyer = await self._fetch(buyer_id)
        if len(self._cache) >= self._max_entries:
            self._cache.clear()
        self._cache[buyer_id] = _Cached(buyer, time.monotonic() + self._ttl)
        return buyer

    async def _fetch(self, buyer_id: str) -> Buyer:
        url = f"{self._admin_url}/users/{quote(buyer_id, safe='')}"
        response = await self._get(url, await self._access_token())
        if response.status_code == httpx.codes.UNAUTHORIZED:
            response = await self._get(url, await self._access_token(renew=True))
        if response.status_code == httpx.codes.NOT_FOUND:
            return Buyer(id=buyer_id, email=None, first_name=None)
        if response.status_code != httpx.codes.OK:
            raise BuyersUnavailable(f"Keycloak respondeu {response.status_code} ao consultar o comprador")
        try:
            body = response.json()
        except ValueError as error:
            raise BuyersUnavailable("resposta do Keycloak não é JSON") from error
        email = body.get("email") if isinstance(body, dict) else None
        first_name = body.get("firstName") if isinstance(body, dict) else None
        return Buyer(
            id=buyer_id,
            email=email if isinstance(email, str) and "@" in email else None,
            first_name=first_name if isinstance(first_name, str) and first_name.strip() else None,
        )

    async def _get(self, url: str, token: str) -> httpx.Response:
        try:
            return await self._http.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=5.0)
        except httpx.HTTPError as error:
            raise BuyersUnavailable(f"Keycloak não respondeu: {type(error).__name__}") from error

    async def _access_token(self, *, renew: bool = False) -> str:
        try:
            return await self._tokens.get(renew=renew)
        except TokenUnavailable as error:
            raise BuyersUnavailable(str(error)) from error

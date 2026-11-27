"""Token da conta de serviço `notification-service` (client credentials no Keycloak).

Um token só serve as duas chamadas do serviço: a API de administração do
Keycloak (o escopo `kc-admin-api` põe a audiência dela, e o papel `view-users`
deixa ler usuários) e a API interna do analytics (o escopo `lotou-api` põe a
audiência `lotou-api` e o papel de realm `service`). Fica em memória até perto
de vencer; quem recebe 401 pede outro uma vez (`renew=True`).
"""

import asyncio
import time

import httpx


class TokenUnavailable(Exception):
    """O Keycloak não deu o token (fora do ar, ou recusou o segredo). Tentar de novo pode resolver."""


class ServiceAccountToken:
    def __init__(self, *, token_url: str, client_id: str, client_secret: str, http: httpx.AsyncClient) -> None:
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = http
        self._token: str | None = None
        self._expires_at = 0.0
        self._lock = asyncio.Lock()

    async def get(self, *, renew: bool = False) -> str:
        async with self._lock:
            if not renew and self._token is not None and time.monotonic() < self._expires_at:
                return self._token
            try:
                response = await self._http.post(
                    self._token_url,
                    data={"grant_type": "client_credentials"},
                    auth=(self._client_id, self._client_secret),
                    timeout=5.0,
                )
            except httpx.HTTPError as error:
                raise TokenUnavailable(f"Keycloak não respondeu: {type(error).__name__}") from error
            if response.status_code != httpx.codes.OK:
                raise TokenUnavailable(f"Keycloak recusou o token da conta de serviço ({response.status_code})")
            body = response.json()
            self._token = str(body["access_token"])
            # Renova 30 s antes de vencer, para não mandar um token que vence no caminho.
            self._expires_at = time.monotonic() + max(float(body.get("expires_in", 60)) - 30, 5)
            return self._token

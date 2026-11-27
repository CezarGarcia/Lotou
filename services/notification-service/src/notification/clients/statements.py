"""Relatório financeiro do show, pela API interna do analytics-service.

`GET {ANALYTICS_SERVICE_URL}/internal/v1/shows/{id}/statement`, com o token da
conta de serviço (papel `service`, audiência `lotou-api`). A resposta traz o
relatório e o que o PDF precisa do show, inclusive o `producerId`, para a API
conferir que quem pediu é o dono. Sem cache: o produtor pede o relatório para
ver os números de agora.
"""

from urllib.parse import quote

import httpx
from pydantic import ValidationError

from notification.clients.service_token import ServiceAccountToken, TokenUnavailable
from notification.tasks import StatementData


class StatementNotFound(Exception):
    """O analytics não conhece o show."""


class StatementsUnavailable(Exception):
    """O analytics (ou o Keycloak, pelo token) não respondeu como devia. Tentar de novo resolve."""


class StatementDirectory:
    def __init__(self, base_url: str, http: httpx.AsyncClient, tokens: ServiceAccountToken) -> None:
        self._base_url = base_url.rstrip("/")
        self._http = http
        self._tokens = tokens

    async def get(self, show_id: str) -> StatementData:
        url = f"{self._base_url}/internal/v1/shows/{quote(show_id, safe='')}/statement"
        response = await self._get(url, await self._token())
        if response.status_code == httpx.codes.UNAUTHORIZED:
            response = await self._get(url, await self._token(renew=True))
        if response.status_code == httpx.codes.NOT_FOUND:
            raise StatementNotFound(f"show {show_id} não existe no analytics")
        if response.status_code != httpx.codes.OK:
            raise StatementsUnavailable(f"analytics respondeu {response.status_code}")
        try:
            return StatementData.model_validate(response.json())
        except (ValueError, ValidationError) as error:
            raise StatementsUnavailable(f"resposta do analytics fora do formato: {error}") from error

    async def _get(self, url: str, token: str) -> httpx.Response:
        try:
            return await self._http.get(
                url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"}, timeout=5.0
            )
        except httpx.HTTPError as error:
            raise StatementsUnavailable(f"analytics não respondeu: {type(error).__name__}") from error

    async def _token(self, *, renew: bool = False) -> str:
        try:
            return await self._tokens.get(renew=renew)
        except TokenUnavailable as error:
            raise StatementsUnavailable(str(error)) from error

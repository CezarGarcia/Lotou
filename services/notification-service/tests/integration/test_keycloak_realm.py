"""O realm do repositório (`infra/keycloak/lotou-realm.json`) num Keycloak de verdade.

A conta de serviço `notification-service` precisa ler o e-mail do comprador na
API de administração, e só isso, e chamar a API interna do analytics (papel
`service`, audiência `lotou-api`). A configuração tem detalhes que um fake não
pegaria: o papel `view-users` do cliente `realm-management` precisa estar no
token (mapeamento de escopo, porque o cliente não tem `fullScopeAllowed`) e,
no Keycloak 26.8 do Compose, o token precisa do escopo `kc-admin-api`, com a audiência
da API de administração.
"""

import re
from collections.abc import Iterator
from pathlib import Path

import httpx
import jwt
import pytest
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy

from notification.clients.buyers import Buyer, BuyerDirectory

REALM = Path(__file__).resolve().parents[4] / "infra" / "keycloak" / "lotou-realm.json"
KEYCLOAK_IMAGE = "quay.io/keycloak/keycloak:26.8"


@pytest.fixture(scope="module")
def keycloak() -> Iterator[str]:
    container = (
        DockerContainer(KEYCLOAK_IMAGE)
        .with_exposed_ports(8080)
        .with_env("KC_BOOTSTRAP_ADMIN_USERNAME", "admin")
        .with_env("KC_BOOTSTRAP_ADMIN_PASSWORD", "admin")
        # Como no Compose: o emissor é a URL pública, e o serviço fala pela rede interna.
        .with_env("KC_HOSTNAME", "http://localhost:8180")
        .with_env("KC_HOSTNAME_BACKCHANNEL_DYNAMIC", "true")
        .with_volume_mapping(str(REALM), "/opt/keycloak/data/import/lotou-realm.json", "ro")
        .with_command("start-dev --import-realm")
        .waiting_for(LogMessageWaitStrategy(re.compile(r"Listening on")).with_startup_timeout(180))
    )
    with container:
        yield f"http://{container.get_container_host_ip()}:{container.get_exposed_port(8080)}"


async def _admin_token(http: httpx.AsyncClient, url: str) -> str:
    response = await http.post(
        f"{url}/realms/master/protocol/openid-connect/token",
        data={"grant_type": "password", "client_id": "admin-cli", "username": "admin", "password": "admin"},
    )
    token: str = response.json()["access_token"]
    return token


async def _user_id(http: httpx.AsyncClient, url: str, username: str) -> str:
    admin = await _admin_token(http, url)
    response = await http.get(
        f"{url}/admin/realms/lotou/users",
        params={"username": username, "exact": "true"},
        headers={"Authorization": f"Bearer {admin}"},
    )
    user_id: str = response.json()[0]["id"]
    return user_id


async def test_service_account_reads_the_buyer_email_and_nothing_else(keycloak: str) -> None:
    async with httpx.AsyncClient(timeout=10) as http:
        buyers = BuyerDirectory(
            token_url=f"{keycloak}/realms/lotou/protocol/openid-connect/token",
            admin_url=f"{keycloak}/admin/realms/lotou",
            client_id="notification-service",
            client_secret="notification-service-dev-secret",
            http=http,
        )
        buyer_id = await _user_id(http, keycloak, "comprador")
        smoke_id = await _user_id(http, keycloak, "service-account-lotou-smoke")

        assert await buyers.get(buyer_id) == Buyer(id=buyer_id, email="comprador@lotou.test", first_name="Bia")
        # A conta de serviço do smoke compra sem e-mail.
        assert (await buyers.get(smoke_id)).email is None

        token = (
            await http.post(
                f"{keycloak}/realms/lotou/protocol/openid-connect/token",
                data={"grant_type": "client_credentials"},
                auth=("notification-service", "notification-service-dev-secret"),
            )
        ).json()["access_token"]
        # O mesmo token chama a API interna do analytics: audiência lotou-api e papel service,
        # e só esse papel do realm.
        claims = jwt.decode(token, options={"verify_signature": False})
        audience = claims["aud"] if isinstance(claims["aud"], list) else [claims["aud"]]
        assert "lotou-api" in audience
        assert claims["realm_access"]["roles"] == ["service"]

        headers = {"Authorization": f"Bearer {token}"}
        # Só leitura de usuários: alterar um usuário, ler clientes ou outro realm é negado.
        changed = await http.put(
            f"{keycloak}/admin/realms/lotou/users/{buyer_id}", json={"firstName": "X"}, headers=headers
        )
        assert changed.status_code == 403
        assert (await http.get(f"{keycloak}/admin/realms/lotou/clients", headers=headers)).status_code == 403
        assert (await http.get(f"{keycloak}/admin/realms/master/users", headers=headers)).status_code == 403

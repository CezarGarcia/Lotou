"""Clientes do event-service (show), do analytics (relatório) e do Keycloak (comprador), contra os fakes HTTP."""

from datetime import UTC, datetime

import pytest

from notification.clients.buyers import Buyer, BuyerDirectory, BuyersUnavailable
from notification.clients.service_token import ServiceAccountToken
from notification.clients.shows import ShowDirectory, ShowNotFound, ShowsUnavailable
from notification.clients.statements import StatementDirectory, StatementNotFound, StatementsUnavailable
from notification.ids import uuid7
from tests.fakes import ANALYTICS_URL, CLIENT_ID, CLIENT_SECRET, EVENT_SERVICE_URL, KEYCLOAK_URL, FakeBackends


def _buyers(fake: FakeBackends, *, secret: str = CLIENT_SECRET, ttl: float = 300.0) -> BuyerDirectory:
    return BuyerDirectory(
        token_url=f"{KEYCLOAK_URL}/realms/lotou/protocol/openid-connect/token",
        admin_url=f"{KEYCLOAK_URL}/admin/realms/lotou",
        client_id=CLIENT_ID,
        client_secret=secret,
        http=fake.client(),
        ttl_seconds=ttl,
    )


async def test_show_comes_from_the_event_service_and_is_cached() -> None:
    fake = FakeBackends()
    show_id = fake.add_show(title="Noite de Teste", timezone="America/Recife")
    shows = ShowDirectory(EVENT_SERVICE_URL, fake.client(), ttl_seconds=60)

    first = await shows.get(show_id)
    second = await shows.get(show_id)

    assert first == second
    assert first.title == "Noite de Teste"
    assert first.timezone == "America/Recife"
    assert first.starts_at == datetime(2026, 12, 13, 0, 0, tzinfo=UTC)
    assert first.venue_name == "Arena Lotou"
    assert fake.show_calls == 1


async def test_show_cache_expires() -> None:
    fake = FakeBackends()
    show_id = fake.add_show()
    shows = ShowDirectory(EVENT_SERVICE_URL, fake.client(), ttl_seconds=0)

    await shows.get(show_id)
    await shows.get(show_id)

    assert fake.show_calls == 2


async def test_missing_show_and_event_service_down_are_different_failures() -> None:
    fake = FakeBackends()
    shows = ShowDirectory(EVENT_SERVICE_URL, fake.client())
    with pytest.raises(ShowNotFound):
        await shows.get(uuid7())

    fake.event_service_down = True
    with pytest.raises(ShowsUnavailable, match="503"):
        await shows.get(fake.add_show())


async def test_buyer_email_and_name_come_from_keycloak() -> None:
    fake = FakeBackends()
    buyer_id = fake.add_buyer(email="bia@lotou.test", first_name="Bia")
    buyers = _buyers(fake)

    buyer = await buyers.get(buyer_id)
    again = await buyers.get(buyer_id)

    assert buyer == again == Buyer(id=buyer_id, email="bia@lotou.test", first_name="Bia")
    assert (fake.token_calls, fake.user_calls) == (1, 1)


async def test_buyer_repr_hides_the_email() -> None:
    buyer = Buyer(id="comprador-1", email="bia@lotou.test", first_name="Bia")
    assert "bia@lotou.test" not in repr(buyer)
    assert "bia@lotou.test" not in str(buyer)


async def test_service_token_is_reused_until_it_expires() -> None:
    fake = FakeBackends()
    buyers = _buyers(fake, ttl=0)
    buyer_id = fake.add_buyer()

    for _ in range(3):
        await buyers.get(buyer_id)

    assert (fake.token_calls, fake.user_calls) == (1, 3)


async def test_rejected_token_is_renewed_once() -> None:
    fake = FakeBackends()
    buyers = _buyers(fake, ttl=0)
    buyer_id = fake.add_buyer()
    await buyers.get(buyer_id)

    fake.issued_tokens.clear()  # o Keycloak reiniciou: o token em cache não vale mais
    buyer = await buyers.get(buyer_id)

    assert buyer.email == "comprador@lotou.test"
    assert fake.token_calls == 2


@pytest.mark.parametrize("email", [None, "", "sem-arroba"])
async def test_buyer_without_email(email: str | None) -> None:
    fake = FakeBackends()
    buyer_id = fake.add_buyer(email=email, first_name=None)

    buyer = await _buyers(fake).get(buyer_id)

    assert buyer == Buyer(id=buyer_id, email=None, first_name=None)


async def test_unknown_buyer_has_no_email() -> None:
    buyer = await _buyers(FakeBackends()).get("nao-existe")
    assert buyer.email is None


async def test_keycloak_down_or_wrong_secret_is_unavailable() -> None:
    fake = FakeBackends()
    buyer_id = fake.add_buyer()
    with pytest.raises(BuyersUnavailable, match="recusou o token"):
        await _buyers(fake, secret="errado").get(buyer_id)

    fake.keycloak_down = True
    with pytest.raises(BuyersUnavailable):
        await _buyers(fake).get(buyer_id)


def _tokens(fake: FakeBackends, http: object, *, secret: str = CLIENT_SECRET) -> ServiceAccountToken:
    return ServiceAccountToken(
        token_url=f"{KEYCLOAK_URL}/realms/lotou/protocol/openid-connect/token",
        client_id=CLIENT_ID,
        client_secret=secret,
        http=http,  # type: ignore[arg-type]
    )


async def test_statement_comes_from_the_analytics_with_the_service_token() -> None:
    fake = FakeBackends()
    show_id = fake.add_statement("produtor-1")
    http = fake.client()
    tokens = _tokens(fake, http)
    statements = StatementDirectory(ANALYTICS_URL, http, tokens)

    statement = await statements.get(show_id)

    assert (statement.producer_id, statement.title, statement.receivable_cents) == (
        "produtor-1",
        "Samba de Quinta",
        36450,
    )
    assert statement.starts_at == datetime(2026, 12, 6, 22, 0, tzinfo=UTC)
    # O mesmo token serve o Keycloak: o diretório de compradores com ele não pede outro.
    fake.add_buyer()
    buyers = BuyerDirectory(
        token_url="nao-usado",
        admin_url=f"{KEYCLOAK_URL}/admin/realms/lotou",
        client_id="",
        client_secret="",
        http=http,
        tokens=tokens,
    )
    await buyers.get(next(iter(fake.users)))
    assert fake.token_calls == 1


async def test_statement_of_an_unknown_show_and_analytics_down_are_different_failures() -> None:
    fake = FakeBackends()
    http = fake.client()
    statements = StatementDirectory(ANALYTICS_URL, http, _tokens(fake, http))
    with pytest.raises(StatementNotFound):
        await statements.get(uuid7())

    fake.analytics_down = True
    with pytest.raises(StatementsUnavailable, match="503"):
        await statements.get(fake.add_statement("produtor-1"))

    fake.analytics_down = False
    wrong_secret = StatementDirectory(ANALYTICS_URL, http, _tokens(fake, http, secret="errado"))
    with pytest.raises(StatementsUnavailable, match="401"):
        await wrong_secret.get(fake.add_statement("produtor-1"))


async def test_expired_service_token_is_renewed_once_for_the_analytics() -> None:
    fake = FakeBackends()
    show_id = fake.add_statement("produtor-1")
    http = fake.client()
    statements = StatementDirectory(ANALYTICS_URL, http, _tokens(fake, http))
    await statements.get(show_id)
    fake.issued_tokens.clear()  # o Keycloak reiniciou: o token em memória não vale mais

    assert (await statements.get(show_id)).show_id == show_id
    assert fake.token_calls == 2

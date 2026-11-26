"""Cursor da paginação e validação da configuração na subida."""

import pytest
from pydantic import ValidationError

from analytics.api.pagination import InvalidCursor, decode_cursor, encode_cursor
from analytics.config import Settings

ORDER_ID = "01a21a00-0000-7000-8000-000000000010"


def test_cursor_round_trip() -> None:
    assert decode_cursor(encode_cursor(ORDER_ID)) == ORDER_ID


@pytest.mark.parametrize(
    "cursor",
    [
        "%%%",
        "bnVsbA",  # null
        "WyJ4Il0",  # ["x"]: não é UUID
        "WzEsMl0",  # [1,2]
        "x" * 201,
    ],
)
def test_invalid_cursor(cursor: str) -> None:
    with pytest.raises(InvalidCursor):
        decode_cursor(cursor)


REQUIRED = {
    "mongodb_uri": "mongodb://mongodb:27017/analytics?replicaSet=rs0",
    "auth_issuer": "http://localhost:8180/realms/lotou",
    "auth_jwks_uri": "http://keycloak:8080/realms/lotou/protocol/openid-connect/certs",
}


def test_defaults() -> None:
    settings = Settings(**REQUIRED)
    assert settings.port == 8084
    assert settings.kafka_brokers == "localhost:9094"
    assert settings.kafka_group_id == "analytics-service"
    assert settings.auth_audience == "lotou-api"
    assert settings.mongodb_database == "analytics"


def test_database_comes_from_the_uri() -> None:
    assert Settings(**REQUIRED | {"mongodb_uri": "mongodb://localhost:27017/outro"}).mongodb_database == "outro"
    assert Settings(**REQUIRED | {"mongodb_uri": "mongodb://localhost:27017"}).mongodb_database == "analytics"


def test_reads_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MONGODB_URI", REQUIRED["mongodb_uri"])
    monkeypatch.setenv("AUTH_ISSUER", REQUIRED["auth_issuer"])
    monkeypatch.setenv("AUTH_JWKS_URI", REQUIRED["auth_jwks_uri"])
    monkeypatch.setenv("KAFKA_BROKERS", "kafka:9092")
    monkeypatch.setenv("PORT", "9000")
    settings = Settings()
    assert (settings.kafka_brokers, settings.port) == ("kafka:9092", 9000)


@pytest.mark.parametrize(
    "override",
    [
        {"mongodb_uri": "postgres://localhost/x"},
        {"auth_issuer": "localhost:8180/realms/lotou"},
        {"port": 0},
        {"consumer_max_attempts": 0},
    ],
)
def test_invalid_configuration_stops_the_startup(override: dict) -> None:
    with pytest.raises(ValidationError):
        Settings(**REQUIRED | override)


def test_missing_required_variable(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("MONGODB_URI", "AUTH_ISSUER", "AUTH_JWKS_URI"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(ValidationError) as raised:
        Settings()
    assert {error["loc"][0] for error in raised.value.errors()} == {"mongodb_uri", "auth_issuer", "auth_jwks_uri"}

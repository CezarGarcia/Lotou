"""Roteamento das tentativas: 10 s, 1 min, 5 min e a DLQ depois da 4ª."""

import pytest

from notification.config import Settings
from notification.rabbit.retry import GiveUp, Retry, attempt_of, next_step
from notification.rabbit.topology import RETRY_KEYS, retry_queue


@pytest.mark.parametrize(
    ("failed", "step"),
    [
        (1, Retry(routing_key="10s", next_attempt=2)),
        (2, Retry(routing_key="1m", next_attempt=3)),
        (3, Retry(routing_key="5m", next_attempt=4)),
        (4, GiveUp(attempts=4)),
        (9, GiveUp(attempts=9)),
    ],
)
def test_next_step_by_attempt(failed: int, step: Retry | GiveUp) -> None:
    assert next_step(failed) == step


def test_four_attempts_in_total() -> None:
    attempt, path = 1, []
    while isinstance(step := next_step(attempt), Retry):
        path.append(step.routing_key)
        attempt = step.next_attempt
    assert path == ["10s", "1m", "5m"]
    assert step == GiveUp(attempts=4)


def test_attempt_starts_at_one() -> None:
    with pytest.raises(ValueError, match="começa em 1"):
        next_step(0)


@pytest.mark.parametrize(
    ("headers", "attempt"),
    [
        (None, 1),
        ({}, 1),
        ({"x-attempt": 3}, 3),
        ({"x-attempt": "2"}, 2),
        ({"x-attempt": b"4"}, 4),
        ({"x-attempt": "abc"}, 1),
        ({"x-attempt": 0}, 1),
        ({"x-attempt": -5}, 1),
    ],
)
def test_attempt_header(headers: dict[str, object] | None, attempt: int) -> None:
    assert attempt_of(headers) == attempt


def test_retry_queues_are_named_after_the_keys() -> None:
    assert [retry_queue(key) for key in RETRY_KEYS] == [
        "notifications.retry.10s",
        "notifications.retry.1m",
        "notifications.retry.5m",
    ]


def test_retry_delays_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KEYCLOAK_CLIENT_SECRET", "x")
    monkeypatch.setenv("AUTH_ISSUER", "http://localhost:8180/realms/lotou")
    monkeypatch.setenv("AUTH_JWKS_URI", "http://keycloak:8080/certs")

    assert Settings().retry_delays_seconds == (10.0, 60.0, 300.0)
    assert Settings().max_attempts == 4

    monkeypatch.setenv("RETRY_DELAYS_SECONDS", "0.5, 1,2")
    assert Settings().retry_delays_seconds == (0.5, 1.0, 2.0)

    monkeypatch.setenv("RETRY_DELAYS_SECONDS", "1,2")
    with pytest.raises(ValueError, match="retry_delays_seconds"):
        Settings()

"""Para onde vai um e-mail que falhou, pelo número da tentativa.

O número da tentativa viaja no cabeçalho `x-attempt` (1 na primeira entrega).
Com as esperas padrão de 10 s, 1 min e 5 min:

| Tentativa que falhou | Próximo passo |
| --- | --- |
| 1 | `notifications.retry` com a chave `10s`; volta com `x-attempt: 2` |
| 2 | chave `1m`, `x-attempt: 3` |
| 3 | chave `5m`, `x-attempt: 4` |
| 4 | `notifications.dlx` → `notifications.email.dlq` |

São 4 tentativas ao todo; o requeue da DLQ começa uma rodada nova, de novo na 1.
"""

from collections.abc import Mapping
from dataclasses import dataclass

from notification.rabbit.topology import RETRY_KEYS

ATTEMPT_HEADER = "x-attempt"


@dataclass(frozen=True)
class Retry:
    routing_key: str
    next_attempt: int


@dataclass(frozen=True)
class GiveUp:
    attempts: int


def next_step(failed_attempt: int, *, retry_keys: tuple[str, ...] = RETRY_KEYS) -> Retry | GiveUp:
    if failed_attempt < 1:
        raise ValueError("a tentativa começa em 1")
    if failed_attempt <= len(retry_keys):
        return Retry(routing_key=retry_keys[failed_attempt - 1], next_attempt=failed_attempt + 1)
    return GiveUp(attempts=failed_attempt)


def attempt_of(headers: Mapping[str, object] | None) -> int:
    """A tentativa desta entrega. Cabeçalho ausente ou inválido conta como a primeira."""
    raw = (headers or {}).get(ATTEMPT_HEADER)
    if isinstance(raw, bytes):
        raw = raw.decode("ascii", "replace")
    try:
        attempt = int(str(raw))
    except (TypeError, ValueError):
        return 1
    return max(attempt, 1)

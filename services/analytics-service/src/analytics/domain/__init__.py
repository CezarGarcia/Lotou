"""Regras das projeções, sem MongoDB nem Kafka."""

from datetime import datetime


def hour_bucket(at: datetime) -> datetime:
    """Hora cheia em UTC da venda: a chave da série horária do `sales_by_sector`."""
    return at.replace(minute=0, second=0, microsecond=0)

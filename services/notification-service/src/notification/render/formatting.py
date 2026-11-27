"""Textos do ingresso e dos e-mails: datas no fuso do show, dinheiro e assento.

As datas chegam em UTC e são exibidas no fuso IANA do local do show (um show em
Manaus aparece no horário de Manaus para quem compra de São Paulo). Os nomes
de dia e mês ficam aqui em português, sem depender do locale do sistema, que a
imagem do container não tem.
"""

from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

WEEKDAYS = ("segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado", "domingo")
MONTHS = (
    "janeiro",
    "fevereiro",
    "março",
    "abril",
    "maio",
    "junho",
    "julho",
    "agosto",
    "setembro",
    "outubro",
    "novembro",
    "dezembro",
)
GENERAL_ADMISSION = "Pista"
# Fuso usado se o show vier sem local; o Lotou vende shows no Brasil.
FALLBACK_TIMEZONE = "America/Sao_Paulo"


def zone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(FALLBACK_TIMEZONE)


def local_time(moment: datetime, timezone: str) -> datetime:
    if moment.tzinfo is None:
        raise ValueError("data sem fuso: as datas do Lotou são gravadas em UTC")
    return moment.astimezone(zone(timezone))


def show_date(moment: datetime, timezone: str) -> str:
    """`sábado, 12 de dezembro de 2026`."""
    local = local_time(moment, timezone)
    return f"{WEEKDAYS[local.weekday()]}, {local.day} de {MONTHS[local.month - 1]} de {local.year}"


def show_time(moment: datetime, timezone: str) -> str:
    """`21h00`."""
    local = local_time(moment, timezone)
    return f"{local.hour:02d}h{local.minute:02d}"


def show_datetime(moment: datetime, timezone: str) -> str:
    """`sábado, 12 de dezembro de 2026, às 21h00 (horário de America/Sao_Paulo)`."""
    return f"{show_date(moment, timezone)}, às {show_time(moment, timezone)} (horário de {zone(timezone).key})"


def seat_label(seat: str | None) -> str:
    """A cadeira (`A-5`) ou `Pista` para quem não tem lugar marcado."""
    return seat if seat else GENERAL_ADMISSION


def money(cents: int) -> str:
    """`R$ 1.234,56`, a partir de centavos inteiros (nunca float)."""
    if cents < 0:
        return f"-{money(-cents)}"
    reais, centavos = divmod(cents, 100)
    return f"R$ {reais:,}".replace(",", ".") + f",{centavos:02d}"


def venue_line(name: str | None, city: str | None, state: str | None) -> str:
    """`Arena Lotou, São Paulo/SP`, com o que houver."""
    place = "/".join(part for part in (city, state) if part)
    return ", ".join(part for part in (name, place) if part) or "Local a confirmar"

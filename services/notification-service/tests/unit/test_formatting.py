"""Datas no fuso do show, dinheiro em centavos e o lugar do ingresso."""

from datetime import UTC, datetime, timedelta, timezone

import pytest

from notification.render import formatting

# 00:30 UTC de 1º de março de 2027, uma segunda-feira.
MOMENT = datetime(2027, 3, 1, 0, 30, tzinfo=UTC)


@pytest.mark.parametrize(
    ("zone", "date", "time"),
    [
        ("America/Sao_Paulo", "domingo, 28 de fevereiro de 2027", "21h30"),
        ("America/Manaus", "domingo, 28 de fevereiro de 2027", "20h30"),
        ("America/Noronha", "domingo, 28 de fevereiro de 2027", "22h30"),
        ("Europe/Lisbon", "segunda-feira, 1 de março de 2027", "00h30"),
    ],
)
def test_date_and_time_in_the_show_time_zone(zone: str, date: str, time: str) -> None:
    assert formatting.show_date(MOMENT, zone) == date
    assert formatting.show_time(MOMENT, zone) == time


def test_the_input_offset_does_not_matter() -> None:
    same_moment = MOMENT.astimezone(timezone(timedelta(hours=9)))
    assert formatting.show_datetime(same_moment, "America/Sao_Paulo") == formatting.show_datetime(
        MOMENT, "America/Sao_Paulo"
    )
    assert formatting.show_datetime(MOMENT, "America/Sao_Paulo") == (
        "domingo, 28 de fevereiro de 2027, às 21h30 (horário de America/Sao_Paulo)"
    )


def test_naive_datetime_is_refused() -> None:
    with pytest.raises(ValueError, match="sem fuso"):
        formatting.show_date(datetime(2027, 3, 1, 0, 30), "America/Sao_Paulo")


def test_unknown_zone_falls_back_to_sao_paulo() -> None:
    assert formatting.show_time(MOMENT, "Marte/Olympus") == "21h30"


@pytest.mark.parametrize(
    ("cents", "text"),
    [(0, "R$ 0,00"), (5, "R$ 0,05"), (32000, "R$ 320,00"), (123456789, "R$ 1.234.567,89"), (-1050, "-R$ 10,50")],
)
def test_money(cents: int, text: str) -> None:
    assert formatting.money(cents) == text


def test_seat_label() -> None:
    assert formatting.seat_label("A-5") == "A-5"
    assert formatting.seat_label(None) == "Pista"
    assert formatting.seat_label("") == "Pista"


def test_venue_line() -> None:
    assert formatting.venue_line("Arena", "São Paulo", "SP") == "Arena, São Paulo/SP"
    assert formatting.venue_line(None, "Recife", None) == "Recife"
    assert formatting.venue_line(None, None, None) == "Local a confirmar"

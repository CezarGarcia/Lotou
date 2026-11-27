"""O PDF do pedido: uma página por ingresso, com os dados do show no fuso dele e o QR code legível."""

from datetime import UTC, datetime

import pytest

from notification.ids import uuid7
from notification.render.pdf import PdfJob, PdfTicket, pdf_text, qr_modules, render_pdf
from tests.events import ticket_code
from tests.pdfs import read_pdf


def _job(*tickets: PdfTicket, title: str = "Noite de Teste", timezone: str = "America/Sao_Paulo") -> PdfJob:
    return PdfJob(
        order_id="01a21a00-0000-7000-8000-000000000010",
        title=title,
        artist="Banda Fictícia",
        # 00:00 UTC de domingo, 13/12: sábado, 21h em São Paulo.
        starts_at=datetime(2026, 12, 13, 0, 0, tzinfo=UTC),
        timezone=timezone,
        venue_name="Arena Lotou",
        venue_city="São Paulo",
        venue_state="SP",
        tickets=tickets,
    )


def _ticket(seat: str | None, sector: str = "Plateia") -> PdfTicket:
    ticket_id = uuid7()
    return PdfTicket(ticket_id=ticket_id, sector_name=sector, seat=seat, code=ticket_code(ticket_id))


def test_one_page_per_ticket_with_the_show_and_the_ticket() -> None:
    seat, pista = _ticket("A-5"), _ticket(None, sector="Pista")

    pages = read_pdf(render_pdf(_job(seat, pista)))

    assert len(pages) == 2
    first, second = pages
    for page in pages:
        assert "Noite de Teste" in page.text
        assert "Banda Fictícia" in page.text
        assert "sábado, 12 de dezembro de 2026" in page.text
        assert "21h00" in page.text
        assert "Arena Lotou, São Paulo/SP" in page.text
        assert "Pedido 01a21a00-0000-7000-8000-000000000010" in page.text
    assert "Ingresso 1 de 2" in first.text
    assert "Setor Plateia" in first.text
    assert "Lugar A-5" in first.text
    assert seat.ticket_id in first.text
    assert "Ingresso 2 de 2" in second.text
    assert "Lugar Pista" in second.text
    assert pista.ticket_id in second.text


def test_qr_code_on_each_page_decodes_to_the_signed_code() -> None:
    tickets = [_ticket(f"B-{n}") for n in range(1, 5)]

    pages = read_pdf(render_pdf(_job(*tickets)))

    assert [page.qr_codes for page in pages] == [[ticket.code] for ticket in tickets]


def test_date_is_shown_in_the_show_time_zone() -> None:
    # O mesmo instante, num show em Manaus (UTC-4): sábado, 20h.
    pages = read_pdf(render_pdf(_job(_ticket("A-1"), timezone="America/Manaus")))

    assert "sábado, 12 de dezembro de 2026" in pages[0].text
    assert "20h00" in pages[0].text
    assert "America/Manaus" in pages[0].text


def test_characters_outside_latin1_do_not_break_the_pdf() -> None:
    pages = read_pdf(render_pdf(_job(_ticket("A-1"), title="Turnê “Verão” — 2026 🎸 Łódź")))

    assert 'Turnê "Verão" - 2026 Lódz' in pages[0].text


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("São Paulo, ação", "São Paulo, ação"),
        ("Show — noite 1", "Show - noite 1"),
        ("‘aspas’ “duplas”…", "'aspas' \"duplas\"..."),
        ("rock 🎸 e samba", "rock e samba"),
        ("Łódź", "Lódz"),
        ("東京", "??"),
    ],
)
def test_pdf_text(raw: str, expected: str) -> None:
    assert pdf_text(raw) == expected


def test_qr_matrix_has_the_quiet_zone() -> None:
    modules = qr_modules(ticket_code(uuid7()))
    assert len(modules) == len(modules[0])
    # Quatro módulos claros em volta, como a norma pede.
    for line in (*modules[:4], *modules[-4:]):
        assert not any(line)
    assert all(not any(row[:4]) and not any(row[-4:]) for row in modules)

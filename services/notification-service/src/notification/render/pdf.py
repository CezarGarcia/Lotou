"""PDF dos ingressos de um pedido: uma página A4 por ingresso, com o QR code.

Função pura (dados em `PdfJob`, bytes do PDF na saída), para rodar num processo
separado do pool de renderização sem levar nada do processo principal.

- **QR code** com o `segno`: o conteúdo é o `code` do ingresso, já assinado pelo
  order-service (ADR 15); aqui ele só é desenhado. Correção de erro M (15%),
  margem de 4 módulos, como pede a norma.
- **PDF** com o `fpdf2`. O QR é desenhado em vetor, um retângulo por trecho de
  módulos escuros de cada linha, sem imagem: fica nítido em qualquer impressão
  e o arquivo fica pequeno (uns poucos KB por página).
- As fontes padrão do PDF (Helvetica, Courier) cobrem o Latin-1, que tem todo o
  português. O que ficar fora (travessão, aspas curvas, emoji num título) é
  trocado por um equivalente ou retirado, para o PDF nunca falhar por causa de
  um caractere.
"""

import unicodedata
from dataclasses import dataclass
from datetime import datetime

import segno
from fpdf import FPDF

from notification.render import formatting

QR_QUIET_ZONE = 4
QR_SIZE_MM = 70.0
PAGE_WIDTH_MM = 210.0
MARGIN_MM = 20.0

INK = (20, 20, 30)
MUTED = (100, 100, 115)
ACCENT = (106, 27, 154)


@dataclass(frozen=True, slots=True)
class PdfTicket:
    ticket_id: str
    sector_name: str
    seat: str | None
    code: str


@dataclass(frozen=True, slots=True)
class PdfJob:
    order_id: str
    title: str
    artist: str
    starts_at: datetime
    timezone: str
    venue_name: str | None
    venue_city: str | None
    venue_state: str | None
    tickets: tuple[PdfTicket, ...]


_REPLACEMENTS = str.maketrans(
    {
        "–": "-",  # meia-risca
        "—": "-",  # travessão
        "‘": "'",
        "’": "'",
        "“": '"',
        "”": '"',
        "…": "...",
        "•": "·",
        # Letras que o NFKD não reduz à base latina.
        "Ł": "L",
        "ł": "l",
        "Đ": "D",
        "đ": "d",
        "Œ": "OE",
        "œ": "oe",
        " ": " ",
    }
)


def pdf_text(text: str) -> str:
    """O texto como as fontes padrão do PDF conseguem escrever (Latin-1)."""
    result: list[str] = []
    for char in unicodedata.normalize("NFC", text.translate(_REPLACEMENTS)):
        if _latin1(char):
            result.append(char)
            continue
        if unicodedata.category(char).startswith(("S", "C")):
            continue  # emoji e outros símbolos, caracteres de controle
        base = "".join(part for part in unicodedata.normalize("NFKD", char) if _latin1(part))
        result.append(base or "?")
    return " ".join("".join(result).split())


def _latin1(char: str) -> bool:
    return ord(char) < 256 and unicodedata.category(char) != "Cc"


def qr_modules(code: str) -> list[list[bool]]:
    """A matriz do QR code, com a margem de silêncio: True é módulo escuro."""
    qr = segno.make(code, error="m", micro=False, boost_error=False)
    return [[bool(module) for module in row] for row in qr.matrix_iter(border=QR_QUIET_ZONE)]


def render_pdf(job: PdfJob) -> bytes:
    pdf = FPDF(orientation="portrait", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=False)
    pdf.set_margins(MARGIN_MM, MARGIN_MM, MARGIN_MM)
    pdf.set_creator("Lotou")
    pdf.set_title(pdf_text(f"Ingressos - {job.title}"))
    pdf.set_subject(f"Pedido {job.order_id}")
    total = len(job.tickets)
    for index, ticket in enumerate(job.tickets, start=1):
        pdf.add_page()
        _page(pdf, job, ticket, index, total)
    return bytes(pdf.output())


def _page(pdf: FPDF, job: PdfJob, ticket: PdfTicket, index: int, total: int) -> None:
    width = PAGE_WIDTH_MM - 2 * MARGIN_MM

    pdf.set_fill_color(*ACCENT)
    pdf.rect(0, 0, PAGE_WIDTH_MM, 24, style="F")
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("helvetica", "B", 18)
    pdf.set_xy(MARGIN_MM, 8)
    pdf.cell(width / 2, 8, "LOTOU")
    pdf.set_font("helvetica", "", 11)
    pdf.cell(width / 2, 8, f"Ingresso {index} de {total}", align="R")

    pdf.set_text_color(*INK)
    pdf.set_xy(MARGIN_MM, 36)
    pdf.set_font("helvetica", "B", 22)
    pdf.multi_cell(width, 10, pdf_text(job.title), new_x="LMARGIN", new_y="NEXT")
    pdf.set_x(MARGIN_MM)
    pdf.set_font("helvetica", "", 15)
    pdf.cell(width, 8, pdf_text(job.artist), new_x="LMARGIN", new_y="NEXT")

    pdf.ln(4)
    _field(pdf, "Data", formatting.show_date(job.starts_at, job.timezone), width)
    _field(
        pdf,
        "Horário",
        f"{formatting.show_time(job.starts_at, job.timezone)} (horário local, {formatting.zone(job.timezone).key})",
        width,
    )
    _field(pdf, "Local", formatting.venue_line(job.venue_name, job.venue_city, job.venue_state), width)
    _field(pdf, "Setor", ticket.sector_name, width)
    _field(pdf, "Lugar", formatting.seat_label(ticket.seat), width)

    top = max(pdf.get_y() + 12, 115.0)
    _qr(pdf, ticket.code, x=(PAGE_WIDTH_MM - QR_SIZE_MM) / 2, y=top, size=QR_SIZE_MM)

    pdf.set_xy(MARGIN_MM, top + QR_SIZE_MM + 4)
    pdf.set_text_color(*MUTED)
    pdf.set_font("courier", "", 9)
    pdf.cell(width, 5, f"Ingresso {ticket.ticket_id}", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(width, 5, f"Pedido {job.order_id}", align="C", new_x="LMARGIN", new_y="NEXT")

    pdf.set_xy(MARGIN_MM, 262)
    pdf.set_font("helvetica", "", 10)
    pdf.multi_cell(
        width,
        5,
        pdf_text(
            "Apresente este QR code na entrada, impresso ou na tela do celular. Cada código vale uma "
            "entrada: não compartilhe nem publique a imagem do seu ingresso."
        ),
        align="C",
    )


def _field(pdf: FPDF, label: str, value: str, width: float) -> None:
    pdf.set_x(MARGIN_MM)
    pdf.set_text_color(*MUTED)
    pdf.set_font("helvetica", "", 10)
    pdf.cell(22, 7, label)
    pdf.set_text_color(*INK)
    pdf.set_font("helvetica", "B", 12)
    pdf.multi_cell(width - 22, 7, pdf_text(value), new_x="LMARGIN", new_y="NEXT")


def _qr(pdf: FPDF, code: str, *, x: float, y: float, size: float) -> None:
    modules = qr_modules(code)
    module = size / len(modules)
    pdf.set_fill_color(255, 255, 255)
    pdf.rect(x, y, size, size, style="F")
    pdf.set_fill_color(0, 0, 0)
    for row, line in enumerate(modules):
        column = 0
        while column < len(line):
            if not line[column]:
                column += 1
                continue
            start = column
            while column < len(line) and line[column]:
                column += 1
            # Um retângulo por trecho escuro da linha; um pouco mais alto que o
            # módulo, para não aparecer fresta entre linhas em leitores de PDF.
            pdf.rect(x + start * module, y + row * module, (column - start) * module, module * 1.02, style="F")

"""PDF do relatório financeiro de um show, para o produtor.

Função pura (dados em `StatementJob`, bytes do PDF na saída), como a dos
ingressos, para rodar no pool de processos. Uma página A4:

- cabeçalho com o show: título, artista, data e hora e local, no fuso do show;
- as linhas do relatório (`contracts/api-fase-6.md`): vendas brutas, descontos
  de cupom, reembolsos e taxa de serviço absorvida, até o valor a receber;
- o que é informativo (taxa paga pelos compradores, pedidos e ingressos);
- se o relatório é parcial (as vendas ainda podem mudar) ou final (o show
  terminou), de quando são os dados e quando o PDF foi gerado, no fuso do show.

Dinheiro em centavos inteiros até a formatação (`R$ 1.234,56`).
"""

from dataclasses import dataclass
from datetime import datetime

from fpdf import FPDF

from notification.render import formatting
from notification.render.pdf import ACCENT, INK, MARGIN_MM, MUTED, PAGE_WIDTH_MM, pdf_text


@dataclass(frozen=True, slots=True)
class StatementJob:
    request_id: str
    title: str
    artist: str
    starts_at: datetime
    timezone: str
    venue_name: str
    partial: bool
    gross_sales_cents: int
    discounts_cents: int
    refunds_cents: int
    platform_fee_cents: int
    buyer_fees_cents: int
    receivable_cents: int
    confirmed_orders: int
    refunded_orders: int
    tickets_sold: int
    tickets_refunded: int
    # Quando o analytics respondeu (os dados) e quando o PDF foi gerado.
    data_at: datetime
    generated_at: datetime


def moment(at: datetime, timezone: str) -> str:
    """`26/11/2026 às 15h00 (horário de America/Sao_Paulo)`."""
    local = formatting.local_time(at, timezone)
    return f"{local:%d/%m/%Y} às {formatting.show_time(at, timezone)} (horário de {formatting.zone(timezone).key})"


def render_statement(job: StatementJob) -> bytes:
    pdf = FPDF(orientation="portrait", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=MARGIN_MM)
    pdf.set_margins(MARGIN_MM, MARGIN_MM, MARGIN_MM)
    pdf.set_creator("Lotou")
    pdf.set_title(pdf_text(f"Relatório financeiro - {job.title}"))
    pdf.set_subject(f"Relatório {job.request_id}")
    pdf.add_page()
    width = PAGE_WIDTH_MM - 2 * MARGIN_MM

    pdf.set_fill_color(*ACCENT)
    pdf.rect(0, 0, PAGE_WIDTH_MM, 24, style="F")
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("helvetica", "B", 18)
    pdf.set_xy(MARGIN_MM, 8)
    pdf.cell(width / 2, 8, "LOTOU")
    pdf.set_font("helvetica", "", 11)
    pdf.cell(width / 2, 8, pdf_text("Relatório financeiro"), align="R")

    pdf.set_text_color(*INK)
    pdf.set_xy(MARGIN_MM, 34)
    pdf.set_font("helvetica", "B", 20)
    pdf.multi_cell(width, 9, pdf_text(job.title), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("helvetica", "", 13)
    pdf.cell(width, 7, pdf_text(job.artist), new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(*MUTED)
    pdf.set_font("helvetica", "", 10)
    pdf.cell(
        width,
        6,
        pdf_text(f"{formatting.show_datetime(job.starts_at, job.timezone)}, {job.venue_name}"),
        new_x="LMARGIN",
        new_y="NEXT",
    )

    pdf.ln(4)
    _status(pdf, job, width)
    pdf.ln(4)

    _line(pdf, "Vendas brutas", job.gross_sales_cents, width)
    _line(pdf, "Descontos de cupom", -job.discounts_cents, width)
    _line(pdf, "Reembolsos", -job.refunds_cents, width)
    _line(pdf, "Taxa de serviço absorvida", -job.platform_fee_cents, width)
    pdf.set_draw_color(*INK)
    pdf.line(MARGIN_MM, pdf.get_y() + 1, MARGIN_MM + width, pdf.get_y() + 1)
    pdf.ln(3)
    _line(pdf, "Valor a receber", job.receivable_cents, width, bold=True)

    pdf.ln(6)
    pdf.set_text_color(*MUTED)
    pdf.set_font("helvetica", "B", 10)
    pdf.cell(width, 6, pdf_text("Informativo"), new_x="LMARGIN", new_y="NEXT")
    _info(pdf, "Taxa de serviço paga pelos compradores", formatting.money(job.buyer_fees_cents), width)
    _info(pdf, "Pedidos confirmados", str(job.confirmed_orders), width)
    _info(pdf, "Pedidos reembolsados", str(job.refunded_orders), width)
    _info(pdf, "Ingressos vendidos", str(job.tickets_sold), width)
    _info(pdf, "Ingressos reembolsados", str(job.tickets_refunded), width)

    pdf.ln(6)
    pdf.set_font("helvetica", "", 9)
    pdf.multi_cell(
        width,
        5,
        pdf_text(
            "Valor a receber = vendas brutas - descontos de cupom - reembolsos - taxa de serviço absorvida. "
            "Um pedido reembolsado continua nas vendas brutas e nos descontos e entra inteiro nos reembolsos; "
            "a taxa dele não é cobrada. A taxa paga pelos compradores não entra no valor a receber."
        ),
        new_x="LMARGIN",
        new_y="NEXT",
    )
    pdf.ln(2)
    pdf.cell(width, 5, pdf_text(f"Dados de {moment(job.data_at, job.timezone)}"), new_x="LMARGIN", new_y="NEXT")
    pdf.cell(width, 5, pdf_text(f"Gerado em {moment(job.generated_at, job.timezone)}"), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("courier", "", 8)
    pdf.cell(width, 5, f"Relatório {job.request_id}", new_x="LMARGIN", new_y="NEXT")
    return bytes(pdf.output())


def _status(pdf: FPDF, job: StatementJob, width: float) -> None:
    pdf.set_font("helvetica", "B", 11)
    if job.partial:
        pdf.set_text_color(*ACCENT)
        text = "Relatório parcial: as vendas, os cancelamentos e os reembolsos ainda podem mudar até o fim do show."
    else:
        pdf.set_text_color(*INK)
        text = "Relatório final: o show terminou."
    pdf.multi_cell(width, 6, pdf_text(text), new_x="LMARGIN", new_y="NEXT")


def _line(pdf: FPDF, label: str, cents: int, width: float, *, bold: bool = False) -> None:
    pdf.set_text_color(*INK)
    pdf.set_font("helvetica", "B" if bold else "", 14 if bold else 12)
    pdf.cell(width * 0.65, 9, pdf_text(label))
    pdf.cell(width * 0.35, 9, pdf_text(formatting.money(cents)), align="R", new_x="LMARGIN", new_y="NEXT")


def _info(pdf: FPDF, label: str, value: str, width: float) -> None:
    pdf.set_text_color(*MUTED)
    pdf.set_font("helvetica", "", 10)
    pdf.cell(width * 0.65, 6, pdf_text(label))
    pdf.cell(width * 0.35, 6, pdf_text(value), align="R", new_x="LMARGIN", new_y="NEXT")

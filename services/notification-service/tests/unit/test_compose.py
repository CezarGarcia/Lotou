"""Os e-mails em texto e HTML, com o PDF anexado no de ingressos."""

from datetime import UTC, datetime
from email.message import EmailMessage

import pytest

from notification.clients.buyers import Buyer
from notification.ids import uuid7
from notification.mail.compose import cancellation_email, tickets_email
from notification.privacy import redact
from notification.tasks import Attachment, CancellationEmail, ShowInfo, TicketsEmail

SHOW = ShowInfo(
    title="Noite <de> Teste",
    artist="Banda Fictícia",
    starts_at=datetime(2026, 12, 13, 0, 0, tzinfo=UTC),
    timezone="America/Sao_Paulo",
    venue_name="Arena Lotou",
    venue_city="São Paulo",
    venue_state="SP",
)
BUYER = Buyer(id="comprador-1", email="bia@lotou.test", first_name="Bia")


def _tickets_task(count: int = 2) -> TicketsEmail:
    return TicketsEmail(
        source_event_id=uuid7(),
        buyer_id=BUYER.id,
        order_id=uuid7(),
        show_id=uuid7(),
        show=SHOW,
        ticket_count=count,
        attachment=Attachment.pdf("ingressos.pdf", b"%PDF-1.4 teste"),
    )


def _bodies(message: EmailMessage) -> tuple[str, str]:
    text = message.get_body(("plain",))
    html = message.get_body(("html",))
    assert text is not None
    assert html is not None
    return text.get_content(), html.get_content()  # type: ignore[attr-defined]


def test_tickets_email_has_text_html_and_the_pdf() -> None:
    task = _tickets_task()

    message = tickets_email(task, BUYER, sender="Lotou <ingressos@lotou.test>")

    assert message["To"] == "bia@lotou.test"
    assert message["From"] == "Lotou <ingressos@lotou.test>"
    assert message["Subject"] == "Seus ingressos para Noite <de> Teste"
    assert message["Message-ID"] == f"<{task.source_event_id}@lotou.test>"
    text, html = _bodies(message)
    assert text.startswith("Olá, Bia!")
    assert "2 ingressos" in text
    assert "sábado, 12 de dezembro de 2026, às 21h00" in text
    assert "Arena Lotou, São Paulo/SP" in text
    assert task.order_id in text
    assert "Noite &lt;de&gt; Teste" in html  # escapado no HTML
    attachments = list(message.iter_attachments())
    assert len(attachments) == 1
    assert attachments[0].get_filename() == "ingressos.pdf"
    assert attachments[0].get_content_type() == "application/pdf"
    assert attachments[0].get_content() == b"%PDF-1.4 teste"


@pytest.mark.parametrize(
    ("reason", "phrase"),
    [
        ("PAYMENT_DECLINED", "o pagamento não foi aprovado"),
        ("RESERVATION_EXPIRED", "a reserva expirou"),
        ("TICKET_CONFLICT", "não foi possível emitir os ingressos"),
        ("MOTIVO_NOVO", "não foi possível concluir a compra"),
    ],
)
def test_cancellation_email_explains_the_reason(reason: str, phrase: str) -> None:
    task = CancellationEmail(
        source_event_id=uuid7(),
        buyer_id=BUYER.id,
        order_id=uuid7(),
        show_id=uuid7(),
        total_cents=32000,
        reason=reason,
        cancelled_at=datetime(2026, 11, 26, 18, 0, tzinfo=UTC),
    )

    message = cancellation_email(task, BUYER, SHOW, sender="Lotou <ingressos@lotou.test>")

    assert message["Subject"] == "Pedido cancelado: Noite <de> Teste"
    text, _ = _bodies(message)
    assert phrase in text
    assert "R$ 320,00" in text
    assert not list(message.iter_attachments())


def test_cancellation_email_without_the_show() -> None:
    task = CancellationEmail(
        source_event_id=uuid7(),
        buyer_id=BUYER.id,
        order_id=uuid7(),
        show_id=uuid7(),
        total_cents=0,
        reason="PAYMENT_DECLINED",
        cancelled_at=datetime(2026, 11, 26, 18, 0, tzinfo=UTC),
    )
    message = cancellation_email(task, Buyer(id="x", email="a@b.test", first_name=None), None, sender="x@lotou.test")

    assert message["Subject"] == "Pedido cancelado: seu show"
    assert _bodies(message)[0].startswith("Olá!")


def test_redact_removes_addresses() -> None:
    error = "SMTPRecipientsRefused: {'bia@lotou.test': (550, b'5.1.1 <bia@lotou.test>: User unknown')}"
    assert "lotou.test" not in redact(error)
    assert redact("sem endereço nenhum") == "sem endereço nenhum"

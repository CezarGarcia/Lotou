"""Os e-mails do comprador: texto simples e HTML simples, em português.

| Template | Assunto | Anexo |
| --- | --- | --- |
| `email.ticket.issued` | Seus ingressos para <show> | o PDF com uma página por ingresso |
| `email.order.cancelled` | Pedido cancelado: <show> | — |

O `Message-ID` sai do `eventId` que originou o e-mail: um leitor de e-mail que
receber o mesmo e-mail duas vezes (no caso raro em que a deduplicação não pega)
os trata como um só.
"""

from email.message import EmailMessage
from email.utils import formatdate
from html import escape

from notification.clients.buyers import Buyer
from notification.render import formatting
from notification.tasks import CancellationEmail, ShowInfo, TicketsEmail

DOMAIN = "lotou.test"

CANCELLATION_REASONS = {
    "PAYMENT_DECLINED": "o pagamento não foi aprovado. Nenhum valor foi cobrado.",
    "RESERVATION_EXPIRED": (
        "a reserva expirou antes da confirmação do pagamento. Se o valor chegou a ser cobrado, o estorno já foi pedido."
    ),
    "TICKET_CONFLICT": "não foi possível emitir os ingressos. O valor pago será estornado.",
}
DEFAULT_REASON = "não foi possível concluir a compra. Se algum valor foi cobrado, ele será estornado."


def tickets_email(task: TicketsEmail, buyer: Buyer, *, sender: str) -> EmailMessage:
    show = task.show
    when = formatting.show_datetime(show.starts_at, show.timezone)
    where = formatting.venue_line(show.venue_name, show.venue_city, show.venue_state)
    count = "1 ingresso" if task.ticket_count == 1 else f"{task.ticket_count} ingressos"
    greeting = _greeting(buyer)

    text = (
        f"{greeting}\n\n"
        f"Sua compra foi confirmada. Seguem em anexo {count} para {show.title} ({show.artist}).\n\n"
        f"Quando: {when}\n"
        f"Onde: {where}\n"
        f"Pedido: {task.order_id}\n\n"
        "Cada página do PDF é um ingresso, com o QR code que será lido na entrada. "
        "Leve o PDF impresso ou no celular e não compartilhe o QR code: cada código vale uma entrada.\n\n"
        "Bom show!\nLotou\n"
    )
    html = _html(
        greeting,
        f"<p>Sua compra foi confirmada. Seguem em anexo {escape(count)} para "
        f"<strong>{escape(show.title)}</strong> ({escape(show.artist)}).</p>"
        f"{_details(when=when, where=where, order_id=task.order_id)}"
        "<p>Cada página do PDF é um ingresso, com o QR code que será lido na entrada. "
        "Leve o PDF impresso ou no celular e não compartilhe o QR code: cada código vale uma entrada.</p>"
        "<p>Bom show!</p>",
    )
    message = _message(
        subject=f"Seus ingressos para {show.title}",
        sender=sender,
        recipient=_recipient(buyer),
        message_id=task.source_event_id,
        text=text,
        html=html,
    )
    attachment = task.attachment
    maintype, _, subtype = attachment.content_type.partition("/")
    message.add_attachment(attachment.content(), maintype=maintype, subtype=subtype, filename=attachment.filename)
    return message


def cancellation_email(task: CancellationEmail, buyer: Buyer, show: ShowInfo | None, *, sender: str) -> EmailMessage:
    reason = CANCELLATION_REASONS.get(task.reason, DEFAULT_REASON)
    title = show.title if show is not None else "seu show"
    greeting = _greeting(buyer)
    total = formatting.money(task.total_cents)
    when = formatting.show_datetime(show.starts_at, show.timezone) if show is not None else None

    text = (
        f"{greeting}\n\n"
        f"Seu pedido para {title} foi cancelado: {reason}\n\n"
        + (f"Show: {title}, {when}\n" if when else "")
        + f"Pedido: {task.order_id}\nValor do pedido: {total}\n\n"
        "Os ingressos voltaram à venda. Se ainda quiser ir, é só comprar de novo na loja.\n\nLotou\n"
    )
    html = _html(
        greeting,
        f"<p>Seu pedido para <strong>{escape(title)}</strong> foi cancelado: {escape(reason)}</p>"
        f"{_details(when=when, where=None, order_id=task.order_id, total=total)}"
        "<p>Os ingressos voltaram à venda. Se ainda quiser ir, é só comprar de novo na loja.</p>",
    )
    return _message(
        subject=f"Pedido cancelado: {title}",
        sender=sender,
        recipient=_recipient(buyer),
        message_id=task.source_event_id,
        text=text,
        html=html,
    )


def _greeting(buyer: Buyer) -> str:
    return f"Olá, {buyer.first_name}!" if buyer.first_name else "Olá!"


def _recipient(buyer: Buyer) -> str:
    if not buyer.email:
        raise ValueError("comprador sem e-mail")
    return buyer.email


def _message(*, subject: str, sender: str, recipient: str, message_id: str, text: str, html: str) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender
    message["To"] = recipient
    message["Date"] = formatdate(localtime=False, usegmt=True)
    message["Message-ID"] = f"<{message_id}@{DOMAIN}>"
    message.set_content(text)
    message.add_alternative(html, subtype="html")
    return message


def _details(*, when: str | None, where: str | None, order_id: str, total: str | None = None) -> str:
    rows = [("Quando", when), ("Onde", where), ("Pedido", order_id), ("Valor do pedido", total)]
    cells = "".join(
        f'<tr><td style="color:#666;padding:2px 12px 2px 0">{escape(label)}</td>'
        f"<td><strong>{escape(value)}</strong></td></tr>"
        for label, value in rows
        if value
    )
    return f'<table style="border-collapse:collapse;margin:12px 0">{cells}</table>'


def _html(greeting: str, body: str) -> str:
    return (
        '<!doctype html><html lang="pt-BR"><body style="font-family:Arial,Helvetica,sans-serif;'
        'color:#14141e;max-width:560px;margin:0 auto;padding:16px">'
        '<div style="background:#6a1b9a;color:#fff;padding:12px 16px;font-weight:bold;font-size:18px">LOTOU</div>'
        f"<p>{escape(greeting)}</p>{body}"
        '<p style="color:#666;font-size:12px">Este é um e-mail automático do Lotou.</p>'
        "</body></html>"
    )

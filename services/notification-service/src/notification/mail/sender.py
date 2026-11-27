"""Envio por SMTP (Mailpit em desenvolvimento), com um span por envio.

O span não leva destinatário nem assunto: só o template, o tamanho e o servidor.
Erro do servidor SMTP pode citar o endereço (`550 <fulano@...>: recusado`);
`redact` o tira antes de a mensagem do erro ir para log, span ou cabeçalho.
"""

from email.message import EmailMessage

import aiosmtplib
from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from notification.privacy import redact

tracer = trace.get_tracer("notification-service")


class SmtpFailed(Exception):
    """O servidor SMTP não aceitou a mensagem (fora do ar, timeout, recusa)."""


class SmtpSender:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        username: str | None = None,
        password: str | None = None,
        start_tls: bool = False,
        timeout: float = 10.0,
    ) -> None:
        self.host = host
        self.port = port
        self._username = username
        self._password = password
        self._start_tls = start_tls
        self._timeout = timeout

    async def send(self, message: EmailMessage, *, template: str) -> None:
        content = message.as_bytes()
        with tracer.start_as_current_span(
            "smtp send",
            kind=SpanKind.CLIENT,
            attributes={
                "server.address": self.host,
                "server.port": self.port,
                "lotou.email.template": template,
                "lotou.email.size": len(content),
            },
            # O texto original de um erro SMTP pode ter o endereço: o span
            # recebe só a versão sem ele, abaixo.
            record_exception=False,
            set_status_on_exception=False,
        ) as span:
            try:
                await aiosmtplib.send(
                    message,
                    hostname=self.host,
                    port=self.port,
                    username=self._username,
                    password=self._password,
                    start_tls=self._start_tls,
                    timeout=self._timeout,
                )
            except (aiosmtplib.SMTPException, OSError, TimeoutError) as error:
                reason = redact(f"{type(error).__name__}: {error}")
                span.set_status(Status(StatusCode.ERROR, reason))
                span.set_attribute("error.type", type(error).__name__)
                raise SmtpFailed(reason) from None

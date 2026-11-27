"""CPF e e-mail nunca aparecem em logs, traces, cabeçalhos ou chaves do Redis.

Os eventos não levam nenhum dos dois, e o e-mail do comprador só existe na
memória do worker de e-mail. O que pode trazer um endereço sem querer é a
mensagem de erro de um servidor SMTP (`550 <fulano@...>: recusado`); `redact`
o tira antes de o texto ir para qualquer lugar.
"""

import re

_EMAIL_PATTERN = re.compile(r"[^\s<>\"'@,;:]+@[^\s<>\"'@,;:]+")


def redact(text: str) -> str:
    """Troca qualquer coisa com cara de e-mail por `<e-mail>`."""
    return _EMAIL_PATTERN.sub("<e-mail>", text)

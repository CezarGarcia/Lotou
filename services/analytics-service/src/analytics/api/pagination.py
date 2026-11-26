"""Paginação por cursor, no formato do event-service.

O cursor guarda o ID do último item da página; a página seguinte começa logo
depois dele. Os pedidos são ordenados pelo `orderId`, que é UUID v7 e portanto
ordenado pela hora de criação: do mais novo para o mais antigo. Diferente de
`skip`, não fica mais lento em páginas fundas nem repete itens quando um pedido
novo entra no meio da leitura.
"""

import base64
import binascii
import json
import re

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class InvalidCursor(ValueError):
    pass


def encode_cursor(last_id: str) -> str:
    return base64.urlsafe_b64encode(json.dumps([last_id]).encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> str:
    """O cursor é opaco para o cliente, mas continua sendo entrada dele: é validado."""
    if len(cursor) > 200:
        raise InvalidCursor("Cursor inválido")
    try:
        raw = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    except (binascii.Error, ValueError):
        raise InvalidCursor("Cursor inválido") from None
    if not (isinstance(raw, list) and len(raw) == 1 and isinstance(raw[0], str) and _UUID.match(raw[0])):
        raise InvalidCursor("Cursor inválido")
    return raw[0]

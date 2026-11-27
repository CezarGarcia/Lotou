"""UUID v7 (RFC 9562): o Python 3.13 ainda não tem `uuid.uuid7`."""

import os
import time
import uuid
from datetime import UTC, datetime


def uuid7() -> str:
    """48 bits de milissegundos desde a época, versão, 74 bits aleatórios e variante."""
    millis = time.time_ns() // 1_000_000
    value = (millis & 0xFFFF_FFFF_FFFF) << 80
    value |= int.from_bytes(os.urandom(10)) & ((1 << 80) - 1)
    value &= ~(0xF << 76)
    value |= 0x7 << 76  # versão 7
    value &= ~(0x3 << 62)
    value |= 0x2 << 62  # variante RFC 9562
    return str(uuid.UUID(int=value))


def utcnow() -> datetime:
    return datetime.now(UTC)

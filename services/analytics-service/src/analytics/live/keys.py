"""Chaves e canais do painel ao vivo no `redis-core` (docs/projeto.md, "Redis Streams e pub/sub").

Nenhuma chave leva comprador, CPF ou e-mail: só o ID do show.
"""

# Tamanho aproximado de cada stream de atividade (`XADD MAXLEN ~`). O painel lê
# as últimas 50 ao assinar; o resto é folga para quem reconecta.
ACTIVITY_MAXLEN = 1000
# Produtor do `XADD IDMP` (Redis 8.6+): com o `eventId` como ID da mensagem, um
# `XADD` repetido depois de um timeout não grava a entrada duas vezes.
ACTIVITY_PRODUCER = "analytics"

# ZSET com os shows que têm alguém assistindo em alguma instância. O score é
# até quando (epoch em ms) o interesse vale; cada instância renova os seus.
WATCHED = "dashboard:watched"


def activity_stream(show_id: str) -> str:
    return f"stream:activity:{show_id}"


def show_of_stream(key: str) -> str:
    return key.removeprefix("stream:activity:")


def metrics_channel(show_id: str) -> str:
    return f"dashboard.metrics:{show_id}"


def show_of_channel(channel: str) -> str:
    return channel.removeprefix("dashboard.metrics:")


def metrics_tick(show_id: str) -> str:
    """Último segundo em que as métricas do show foram calculadas (quem calcula é quem grava)."""
    return f"dashboard:metrics-tick:{show_id}"


StreamId = tuple[int, int]


def parse_stream_id(value: str) -> StreamId:
    ms, _, seq = value.partition("-")
    return int(ms), int(seq or 0)


def format_stream_id(value: StreamId) -> str:
    return f"{value[0]}-{value[1]}"

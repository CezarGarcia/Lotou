"""Fila de envio de cada WebSocket (cliente lento) e a passagem da foto para o ao vivo."""

import asyncio
from datetime import UTC, datetime

from analytics.live.connection import Connection, Frame
from analytics.live.hub import Subscription
from analytics.live.protocol import CLOSE_TRY_AGAIN


class FakeSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.closed: tuple[int, str | None] | None = None
        self.gate = asyncio.Event()
        self.gate.set()

    async def send_text(self, data: str) -> None:
        await self.gate.wait()
        self.sent.append(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        self.closed = (code, reason)


async def drain(connection: Connection, socket: FakeSocket, count: int) -> None:
    for _ in range(200):
        if len(socket.sent) >= count:
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"enviados {socket.sent}")


async def test_a_slow_client_skips_metrics_but_never_activity() -> None:
    socket = FakeSocket()
    socket.gate.clear()  # o cliente parou de ler
    connection = Connection(socket, max_pending=10)
    sender = asyncio.create_task(connection.run())
    for second in range(5):
        connection.send_metrics("a", Frame(f"metrics-a-{second}", "a"))
        connection.send_metrics("b", Frame(f"metrics-b-{second}", "b"))
    connection.send(Frame("activity-1", "a"))
    connection.send(Frame("activity-2", "a"))
    socket.gate.set()
    await drain(connection, socket, 4)
    await asyncio.sleep(0.02)
    # A atividade toda, e só a métrica mais recente de cada show.
    assert socket.sent == ["activity-1", "activity-2", "metrics-a-4", "metrics-b-4"]
    connection.close(1000, "")
    await sender
    assert socket.closed == (1000, "")


async def test_a_full_queue_closes_the_connection_instead_of_dropping_activity() -> None:
    socket = FakeSocket()
    socket.gate.clear()
    connection = Connection(socket, max_pending=3)
    sender = asyncio.create_task(connection.run())
    for index in range(5):
        connection.send(Frame(f"activity-{index}", "a"))
    assert connection.close_code == CLOSE_TRY_AGAIN
    socket.gate.set()
    await asyncio.wait_for(sender, timeout=1)
    assert socket.closed == (CLOSE_TRY_AGAIN, "cliente lento: a fila de envio encheu")
    assert connection.closed.is_set()


async def test_a_stuck_send_closes_the_connection() -> None:
    socket = FakeSocket()
    socket.gate.clear()
    connection = Connection(socket, send_timeout=0.05)
    sender = asyncio.create_task(connection.run())
    connection.send(Frame("activity", "a"))
    await asyncio.wait_for(sender, timeout=1)
    assert socket.closed is not None
    assert socket.closed[0] == CLOSE_TRY_AGAIN


async def test_forget_drops_what_is_queued_for_the_show() -> None:
    socket = FakeSocket()
    socket.gate.clear()
    connection = Connection(socket)
    connection.send(Frame("a-1", "a"))
    connection.send(Frame("b-1", "b"))
    connection.send_metrics("a", Frame("metrics-a", "a"))
    connection.forget("a")
    sender = asyncio.create_task(connection.run())
    socket.gate.set()
    await drain(connection, socket, 1)
    await asyncio.sleep(0.02)
    assert socket.sent == ["b-1"]
    connection.close(1000, "")
    await sender


def frame(text: str) -> Frame:
    return Frame(text, "a", datetime(2026, 11, 26, tzinfo=UTC), "OrderConfirmed")


async def test_activity_read_while_the_snapshot_is_built_is_not_lost_nor_repeated() -> None:
    socket = FakeSocket()
    connection = Connection(socket)
    subscription = Subscription(connection, "a")
    # O leitor do stream entrega antes da foto ficar pronta: fica guardado, fora de ordem até.
    subscription.deliver((5, 0), frame("5"))
    subscription.deliver((3, 0), frame("3"))
    subscription.deliver((4, 0), frame("4"))
    assert connection.pending == 0
    # A foto já tinha tudo até 3-0.
    subscription.go_live((3, 0))
    subscription.deliver((4, 0), frame("4"))  # o leitor pode entregar de novo
    subscription.deliver((6, 0), frame("6"))
    sender = asyncio.create_task(connection.run())
    await drain(connection, socket, 3)
    assert socket.sent == ["4", "5", "6"]
    connection.close(1000, "")
    await sender

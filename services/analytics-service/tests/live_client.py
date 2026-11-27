"""Cliente do WebSocket do painel para os testes, que guarda todos os frames com a hora de
chegada, e um uvicorn de verdade numa porta local para servir o app."""

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import uvicorn
from fastapi import FastAPI
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed


@dataclass
class Server:
    server: uvicorn.Server
    task: asyncio.Task[None]
    port: int

    def url(self, path: str) -> str:
        return f"ws://127.0.0.1:{self.port}{path}"

    async def stop(self) -> None:
        self.server.should_exit = True
        await asyncio.gather(self.task, return_exceptions=True)


async def serve(app: FastAPI, *, lifespan: str = "on") -> Server:
    """Sobe o app no uvicorn (porta livre) e espera ele aceitar conexões."""
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_config=None, lifespan=lifespan))
    task = asyncio.create_task(server.serve())
    deadline = time.monotonic() + 60
    while not server.started:
        if task.done() or time.monotonic() > deadline:
            raise RuntimeError("o uvicorn não subiu")
        await asyncio.sleep(0.02)
    return Server(server, task, server.servers[0].sockets[0].getsockname()[1])


@dataclass(frozen=True)
class Received:
    frame: dict[str, Any]
    monotonic: float
    wall: float


class LiveClient:
    def __init__(self, ws: ClientConnection) -> None:
        self.ws = ws
        self.received: list[Received] = []
        self.closed = asyncio.Event()
        self._new = asyncio.Event()
        self._reader = asyncio.create_task(self._read())

    @classmethod
    async def open(cls, url: str) -> "LiveClient":
        return cls(await connect(url, open_timeout=10))

    @property
    def close_code(self) -> int | None:
        return self.ws.close_code

    @property
    def frames(self) -> list[dict[str, Any]]:
        return [item.frame for item in self.received]

    def mark(self) -> int:
        return len(self.received)

    async def send(self, **message: Any) -> None:
        await self.ws.send(json.dumps(message))

    async def auth(self, token: str) -> dict[str, Any]:
        start = self.mark()
        await self.send(type="auth", token=token)
        return (await self.wait_for(lambda f: f["type"] == "ready", since=start)).frame

    async def subscribe(self, show_id: str) -> dict[str, Any]:
        start = self.mark()
        await self.send(type="subscribe", showId=show_id)
        received = await self.wait_for(
            lambda f: f["type"] in ("snapshot", "error") and f.get("showId") == show_id, since=start
        )
        return received.frame

    async def wait_for(
        self, predicate: Callable[[dict[str, Any]], bool], *, since: int = 0, within: float = 10.0
    ) -> Received:
        deadline = time.monotonic() + within
        position = since
        while True:
            for index in range(position, len(self.received)):
                if predicate(self.received[index].frame):
                    return self.received[index]
            position = len(self.received)
            remaining = deadline - time.monotonic()
            if remaining <= 0 or self.closed.is_set():
                raise AssertionError(f"frame esperado não chegou; recebidos: {self.frames[since:]}")
            self._new.clear()
            try:
                await asyncio.wait_for(self._new.wait(), timeout=remaining)
            except TimeoutError:
                continue

    async def wait_closed(self, within: float = 10.0) -> int | None:
        await asyncio.wait_for(self.closed.wait(), timeout=within)
        return self.close_code

    async def close(self) -> None:
        await self.ws.close()
        await asyncio.gather(self._reader, return_exceptions=True)

    async def _read(self) -> None:
        try:
            async for raw in self.ws:
                self.received.append(Received(json.loads(raw), time.monotonic(), time.time()))
                self._new.set()
        except ConnectionClosed:
            pass
        finally:
            self.closed.set()
            self._new.set()

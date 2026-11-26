"""Replay dos read models: pela API interna (`POST /internal/v1/replay`) ou por `python -m analytics.replay`."""

import asyncio
import logging
from collections.abc import Callable

from analytics.replay.runner import ReplayResult, ReplayRunner, ReplayStopped

logger = logging.getLogger(__name__)

__all__ = ["BackgroundReplays", "ReplayResult", "ReplayRunner", "ReplayStopped"]


class BackgroundReplays:
    """Replays disparados pela API: rodam numa task do próprio processo."""

    def __init__(self, runner_factory: Callable[[], ReplayRunner]) -> None:
        self._runner_factory = runner_factory
        self._running: dict[int, tuple[ReplayRunner, asyncio.Task[None]]] = {}

    async def trigger(self) -> int:
        """Reserva a geração e começa a montá-la. Levanta `ReplayInProgress` se já houver um replay."""
        runner = self._runner_factory()
        generation = await runner.prepare()
        task = asyncio.create_task(self._build(runner, generation), name=f"analytics-replay-gen-{generation}")
        self._running[generation] = (runner, task)
        return generation

    async def _build(self, runner: ReplayRunner, generation: int) -> None:
        try:
            await runner.build(generation)
        except Exception:
            pass  # o runner já registrou o erro e marcou a geração como FAILED
        finally:
            self._running.pop(generation, None)

    async def shutdown(self) -> None:
        """Interrompe os replays em andamento: a geração fica FAILED e a ativa segue como estava."""
        for runner, _ in self._running.values():
            runner.request_stop()
        tasks = [task for _, task in self._running.values()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

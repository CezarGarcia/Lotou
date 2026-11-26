"""Replay pela linha de comando: `python -m analytics.replay`.

Roda no próprio container do serviço (`make replay-analytics`), com o serviço
no ar: a API segue lendo a geração ativa até a troca, e o supervisor do serviço
move o consumidor ao vivo para a geração nova assim que o ponteiro muda.

Códigos de saída: 0 concluído, 1 falhou, 2 já havia um replay em andamento.
"""

import asyncio
import json
import logging
import signal
import sys

from analytics.config import Settings
from analytics.kafka.dead_letter import DeadLetterPublisher
from analytics.replay.runner import ReplayRunner
from analytics.store import connect
from analytics.store.generations import ReplayInProgress
from analytics.telemetry import setup
from analytics.wiring import build_registry

logger = logging.getLogger("analytics.replay")


async def run(settings: Settings) -> int:
    client = connect(settings)
    dead_letter = DeadLetterPublisher(settings.kafka_brokers)
    runner = ReplayRunner(
        settings=settings, client=client, registry=build_registry(settings, client), dead_letter=dead_letter
    )
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, runner.request_stop)
    try:
        try:
            generation = await runner.prepare()
        except ReplayInProgress as error:
            logger.error("Já existe um replay em andamento", extra={"generation": error.generation})
            return 2
        try:
            result = await runner.build(generation)
        except Exception:
            return 1  # o runner já registrou o erro e marcou a geração como FAILED
        print(
            json.dumps(
                {
                    "generation": result.generation,
                    "previousGeneration": result.previous,
                    "eventsApplied": result.events_applied,
                    "seconds": result.seconds,
                }
            )
        )
        return 0
    finally:
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(sig)
        await dead_letter.stop()
        await client.close()


def main() -> int:
    settings = Settings()  # vem das variáveis de ambiente
    telemetry = setup(settings)
    try:
        return asyncio.run(run(settings))
    finally:
        telemetry.shutdown()


if __name__ == "__main__":
    sys.exit(main())

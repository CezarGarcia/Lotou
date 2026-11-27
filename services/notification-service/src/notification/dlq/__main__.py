"""Linha de comando das DLQs.

    python -m notification.dlq depth
    python -m notification.dlq requeue [--queue email|render|reports|all] [--limit N]

Só precisa de `RABBITMQ_URL`. Sai com 0 quando deu certo, 1 quando falhou e
2 quando alguma mensagem ilegível ficou na DLQ.
"""

import argparse
import asyncio
import json
import sys

import aio_pika
from pydantic import AnyUrl
from pydantic_settings import BaseSettings, SettingsConfigDict

from notification.dlq import depths, requeue
from notification.rabbit import topology
from notification.rabbit.publisher import Publisher

QUEUES = {
    "email": (topology.EMAIL_DLQ,),
    "render": (topology.RENDER_DLQ,),
    "reports": (topology.REPORTS_DLQ,),
    "all": topology.DLQS,
}


class CliSettings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    rabbitmq_url: AnyUrl = AnyUrl("amqp://guest:guest@localhost:5672/")


async def _run(args: argparse.Namespace) -> int:
    settings = CliSettings()
    connection = await aio_pika.connect_robust(
        str(settings.rabbitmq_url), client_properties={"connection_name": "notification-service dlq"}
    )
    try:
        if args.command == "depth":
            channel = await connection.channel()
            print(json.dumps(await depths(channel)))
            return 0
        publisher = Publisher(connection)
        skipped = 0
        for queue in QUEUES[args.queue]:
            result = await requeue(connection, publisher, queue, limit=args.limit)
            skipped += result.skipped
            print(json.dumps({"queue": result.queue, "requeued": result.requeued, "skipped": result.skipped}))
        await publisher.close()
        return 2 if skipped else 0
    finally:
        await connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(prog="python -m notification.dlq", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("depth", help="mensagens em cada DLQ")
    move = commands.add_parser("requeue", help="devolve as mensagens da DLQ para uma nova rodada")
    move.add_argument("--queue", choices=sorted(QUEUES), default="all")
    move.add_argument("--limit", type=int, default=None, help="no máximo N mensagens por DLQ")
    args = parser.parse_args()
    try:
        code = asyncio.run(_run(args))
    except Exception as error:
        print(f"falhou: {type(error).__name__}: {error}", file=sys.stderr)
        code = 1
    sys.exit(code)


if __name__ == "__main__":
    main()

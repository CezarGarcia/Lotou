"""MongoDB e Redis: conexões, gerações e coleções dos read models."""

from typing import Any

from pymongo.asynchronous.mongo_client import AsyncMongoClient
from redis.asyncio import Redis

from analytics.config import Settings


def connect(settings: Settings) -> AsyncMongoClient[dict[str, Any]]:
    """Cliente do MongoDB. As datas voltam com fuso (UTC), como foram gravadas."""
    return AsyncMongoClient(
        settings.mongodb_uri,
        tz_aware=True,
        appname="analytics-service",
        serverSelectionTimeoutMS=5_000,
    )


def connect_redis(settings: Settings) -> Redis:
    """Cliente do redis-core. Respostas em texto: as chaves e os valores daqui são JSON e IDs."""
    return Redis.from_url(
        settings.redis_url,
        decode_responses=True,
        client_name="analytics-service",
        socket_connect_timeout=5,
        health_check_interval=30,
    )

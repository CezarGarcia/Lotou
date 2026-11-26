"""MongoDB: conexão, gerações e coleções dos read models."""

from typing import Any

from pymongo.asynchronous.mongo_client import AsyncMongoClient

from analytics.config import Settings


def connect(settings: Settings) -> AsyncMongoClient[dict[str, Any]]:
    """Cliente do MongoDB. As datas voltam com fuso (UTC), como foram gravadas."""
    return AsyncMongoClient(
        settings.mongodb_uri,
        tz_aware=True,
        appname="analytics-service",
        serverSelectionTimeoutMS=5_000,
    )

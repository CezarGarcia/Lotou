"""Montagem das peças compartilhadas pelo serviço HTTP e pela linha de comando do replay."""

from datetime import timedelta
from typing import Any

from pymongo.asynchronous.mongo_client import AsyncMongoClient

from analytics.config import Settings
from analytics.store.generations import GenerationRegistry


def build_registry(settings: Settings, client: AsyncMongoClient[dict[str, Any]]) -> GenerationRegistry:
    return GenerationRegistry(
        client,
        client[settings.mongodb_database],
        group_prefix=settings.kafka_group_id,
        retired_grace=timedelta(seconds=settings.retired_generation_grace_seconds),
        processed_ttl=timedelta(days=settings.processed_events_ttl_days),
        replay_lease=timedelta(seconds=settings.replay_lease_seconds),
    )

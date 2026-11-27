"""Dependências reais para os testes de integração: um MongoDB, um Kafka e um Redis por sessão."""

import uuid
from collections.abc import AsyncIterator, Iterator
from typing import Any

import pytest
from aiokafka.admin import AIOKafkaAdminClient, NewTopic
from pymongo.asynchronous.mongo_client import AsyncMongoClient

from tests.integration.containers import KafkaKraft, MongoReplicaSet, RedisCore

TOPIC_CONFIGS: dict[str, dict[str, str]] = {
    "shows.catalog": {"cleanup.policy": "compact"},
    "order.events": {"retention.ms": "-1"},
    "inventory.events": {"retention.ms": "-1"},
}


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if "integration" in item.nodeid:
            item.add_marker(pytest.mark.integration)


@pytest.fixture(scope="session")
def mongo() -> Iterator[MongoReplicaSet]:
    with MongoReplicaSet() as container:
        yield container


@pytest.fixture(scope="session")
def kafka() -> Iterator[KafkaKraft]:
    with KafkaKraft() as container:
        yield container


@pytest.fixture(scope="session")
def redis_core() -> Iterator[RedisCore]:
    with RedisCore() as container:
        yield container


@pytest.fixture(scope="session")
async def topics(kafka: KafkaKraft) -> list[str]:
    """Os tópicos do `infra/kafka/create-topics.sh`, com três partições, e as DLTs."""
    admin = AIOKafkaAdminClient(bootstrap_servers=kafka.bootstrap_servers)
    await admin.start()
    try:
        new = [
            NewTopic(name=name, num_partitions=3, replication_factor=1, topic_configs=config)
            for name, config in TOPIC_CONFIGS.items()
        ]
        new += [NewTopic(name=f"{name}.dlt", num_partitions=1, replication_factor=1) for name in TOPIC_CONFIGS]
        await admin.create_topics(new)
    finally:
        await admin.close()
    return list(TOPIC_CONFIGS)


@pytest.fixture
async def mongo_client(mongo: MongoReplicaSet) -> AsyncIterator[AsyncMongoClient[dict[str, Any]]]:
    client: AsyncMongoClient[dict[str, Any]] = AsyncMongoClient(mongo.uri("admin"), tz_aware=True)
    yield client
    await client.close()


@pytest.fixture
def database_name() -> str:
    return f"analytics_test_{uuid.uuid4().hex[:8]}"

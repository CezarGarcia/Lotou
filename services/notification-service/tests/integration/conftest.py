"""Dependências reais para os testes de integração: Kafka, RabbitMQ, Redis e Mailpit, um de cada por sessão.

O Keycloak, o event-service e o analytics são os fakes HTTP de `tests/fakes.py`:
são APIs, não banco nem broker. O OpenTelemetry fica ligado, com exportadores em memória,
para os testes conferirem o trace atravessando Kafka, RabbitMQ e SMTP e as
métricas do documento.
"""

import asyncio
import socket
from collections.abc import AsyncIterator, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import aio_pika
import httpx
import pytest
from aiokafka import AIOKafkaProducer
from aiokafka.admin import AIOKafkaAdminClient, NewTopic
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from notification.config import Settings
from notification.rabbit import topology
from notification.service import Components, NotificationService
from notification.telemetry import instrument_libraries
from tests.events import TOPIC, Message
from tests.fakes import ANALYTICS_URL, CLIENT_SECRET, EVENT_SERVICE_URL, KEYCLOAK_URL, FakeBackends
from tests.integration.containers import KafkaKraft, Mailpit, RabbitMq, RedisServer
from tests.tokens import ISSUER, JWKS_URI

# A mesma para a sessão inteira: o RabbitMQ recusa declarar uma fila de retry
# que já existe com outro `x-message-ttl`.
RETRY_DELAYS = (0.4, 0.4, 0.4)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    for item in items:
        if "integration" in item.nodeid:
            item.add_marker(pytest.mark.integration)


@dataclass
class Infra:
    kafka: KafkaKraft
    rabbitmq: RabbitMq
    redis: RedisServer
    mailpit: Mailpit


@pytest.fixture(scope="session")
def infra() -> Iterator[Infra]:
    # O Redis sobe primeiro e sozinho: ele cria o container de limpeza do
    # Testcontainers (Ryuk), que não pode ser criado por duas threads ao mesmo
    # tempo. Os outros sobem em paralelo; o Kafka e o RabbitMQ levam uns segundos.
    started: list[Any] = [RedisServer().start()]
    others = [KafkaKraft(), RabbitMq(), Mailpit()]
    with ThreadPoolExecutor(max_workers=len(others)) as pool:
        started += list(pool.map(lambda container: container.start(), others))
    redis, kafka, rabbitmq, mailpit = started
    try:
        yield Infra(kafka=kafka, rabbitmq=rabbitmq, redis=redis, mailpit=mailpit)
    finally:
        for container in started:
            container.stop()


@pytest.fixture(scope="session")
async def topics(infra: Infra) -> None:
    admin = AIOKafkaAdminClient(bootstrap_servers=infra.kafka.bootstrap_servers)
    await admin.start()
    try:
        await admin.create_topics(
            [
                NewTopic(name=TOPIC, num_partitions=3, replication_factor=1, topic_configs={"retention.ms": "-1"}),
                NewTopic(name=f"{TOPIC}.dlt", num_partitions=1, replication_factor=1),
            ]
        )
    finally:
        await admin.close()


# ---------------------------------------------------------------- telemetria


@dataclass
class Telemetry:
    spans: InMemorySpanExporter
    metrics: InMemoryMetricReader

    def points(self, name: str) -> list[tuple[dict[str, Any], float]]:
        data = self.metrics.get_metrics_data()
        found: list[tuple[dict[str, Any], float]] = []
        if data is None:
            return found
        for resource in data.resource_metrics:
            for scope in resource.scope_metrics:
                for metric in scope.metrics:
                    if metric.name == name:
                        # Contador e gauge têm `value`; histograma, `count` (quantas medidas).
                        found += [
                            (dict(p.attributes or {}), getattr(p, "value", None) or getattr(p, "count", 0))
                            for p in metric.data.data_points
                        ]
        return found

    def value(self, name: str, **attributes: str) -> float:
        return sum(value for attrs, value in self.points(name) if attributes.items() <= attrs.items())


@pytest.fixture(scope="session")
def telemetry() -> Telemetry:
    spans = InMemorySpanExporter()
    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(SimpleSpanProcessor(spans))
    trace.set_tracer_provider(tracer_provider)
    reader = InMemoryMetricReader()
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
    instrument_libraries()
    return Telemetry(spans=spans, metrics=reader)


# ------------------------------------------------------------------ serviço


def closed_port() -> int:
    """Uma porta em que ninguém escuta: o SMTP "fora do ar"."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port: int = sock.getsockname()[1]
    return port


@pytest.fixture
def make_settings(infra: Infra, topics: None) -> Any:
    def make(**overrides: Any) -> Settings:
        values: dict[str, Any] = {
            "kafka_brokers": infra.kafka.bootstrap_servers,
            "rabbitmq_url": infra.rabbitmq.url,
            "redis_url": infra.redis.url,
            "smtp_host": infra.mailpit.smtp_host,
            "smtp_port": infra.mailpit.smtp_port,
            "smtp_timeout_seconds": 2.0,
            "event_service_url": EVENT_SERVICE_URL,
            "analytics_service_url": ANALYTICS_URL,
            "keycloak_url": KEYCLOAK_URL,
            "keycloak_client_secret": CLIENT_SECRET,
            "auth_issuer": ISSUER,
            "auth_jwks_uri": JWKS_URI,
            "retry_delays_seconds": RETRY_DELAYS,
            "render_workers": 2,
            "dlq_poll_seconds": 0.3,
            "show_cache_seconds": 0,
            "buyer_cache_seconds": 0,
            "otel_sdk_disabled": True,
        }
        values.update(overrides)
        return Settings(**values)

    return make


@pytest.fixture
def backends() -> FakeBackends:
    return FakeBackends()


@pytest.fixture
def run_service(make_settings: Any, backends: FakeBackends, telemetry: Telemetry) -> Any:
    @asynccontextmanager
    async def run(*, components: frozenset[str] | None = None, **overrides: Any) -> AsyncIterator[NotificationService]:
        settings = make_settings(**overrides)
        enabled = Components(
            enabled=components or frozenset({"kafka", "render", "email", "reports"}),
            kafka_retry_base_seconds=0.05,
            render_retry_base_seconds=0.1,
        )
        async with backends.client() as http:
            service = NotificationService(settings, http=http, components=enabled)
            await service.start()
            try:
                if "kafka" in enabled.enabled:
                    await wait_for(lambda: service.consumer is not None and service.consumer.ready.is_set(), 30)
                yield service
            finally:
                await service.stop()

    return run


async def wait_for(condition: Any, seconds: float = 20.0, interval: float = 0.1) -> None:
    deadline = asyncio.get_running_loop().time() + seconds
    while True:
        result = condition()
        if asyncio.iscoroutine(result):
            result = await result
        if result:
            return
        if asyncio.get_running_loop().time() > deadline:
            raise TimeoutError("a condição não foi atendida no prazo")
        await asyncio.sleep(interval)


# ------------------------------------------------------------- RabbitMQ


@pytest.fixture
async def rabbit(infra: Infra) -> AsyncIterator[aio_pika.abc.AbstractRobustConnection]:
    connection = await aio_pika.connect_robust(infra.rabbitmq.url)
    channel = await connection.channel()
    await topology.declare(channel, RETRY_DELAYS)
    await channel.close()
    yield connection
    await connection.close()


async def queue_depth(connection: aio_pika.abc.AbstractRobustConnection, queue: str) -> int:
    channel = await connection.channel()
    try:
        return await topology.depth(channel, queue)
    finally:
        await channel.close()


ALL_QUEUES = (
    topology.RENDER_QUEUE,
    topology.RENDER_DLQ,
    topology.EMAIL_QUEUE,
    topology.EMAIL_DLQ,
    topology.REPORTS_QUEUE,
    topology.REPORTS_DLQ,
    *(topology.retry_queue(key) for key in topology.RETRY_KEYS),
)


@pytest.fixture(autouse=True)
async def clean_state(rabbit: aio_pika.abc.AbstractRobustConnection, mailpit: "MailpitApi") -> None:
    """Cada teste começa com as filas vazias e a caixa do Mailpit limpa."""
    channel = await rabbit.channel()
    for name in ALL_QUEUES:
        queue = await channel.declare_queue(name, passive=True)
        await queue.purge()
    await channel.close()
    await mailpit.clear()


# --------------------------------------------------------------- Kafka


@pytest.fixture
async def producer(infra: Infra, topics: None) -> AsyncIterator[AIOKafkaProducer]:
    kafka = AIOKafkaProducer(bootstrap_servers=infra.kafka.bootstrap_servers, acks="all")
    await kafka.start()
    yield kafka
    await kafka.stop()


async def publish(
    producer: AIOKafkaProducer,
    message: Message | bytes,
    *,
    key: str | None = None,
    headers: list[tuple[str, bytes]] | None = None,
) -> None:
    """Publica em `order.events`. A chave padrão é a do pedido; a mesma chave cai na mesma partição, em ordem."""
    value = message if isinstance(message, bytes) else message.raw()
    record_key = key or (message.key if isinstance(message, Message) else "sem-chave")
    await producer.send_and_wait(TOPIC, value=value, key=record_key.encode(), headers=headers or [])


# --------------------------------------------------------------- Mailpit


class MailpitApi:
    def __init__(self, base_url: str) -> None:
        self._http = httpx.AsyncClient(base_url=base_url, timeout=5.0)

    async def clear(self) -> None:
        (await self._http.delete("/api/v1/messages")).raise_for_status()

    async def messages(self) -> list[dict[str, Any]]:
        response = await self._http.get("/api/v1/messages", params={"limit": 500})
        response.raise_for_status()
        found: list[dict[str, Any]] = response.json()["messages"]
        return found

    async def wait_for(self, count: int, *, seconds: float = 20.0) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []

        async def enough() -> bool:
            nonlocal found
            found = await self.messages()
            return len(found) >= count

        await wait_for(enough, seconds, interval=0.2)
        return found

    async def message(self, message_id: str) -> dict[str, Any]:
        response = await self._http.get(f"/api/v1/message/{message_id}")
        response.raise_for_status()
        body: dict[str, Any] = response.json()
        return body

    async def attachment(self, message_id: str, part_id: str) -> bytes:
        response = await self._http.get(f"/api/v1/message/{message_id}/part/{part_id}")
        response.raise_for_status()
        return response.content

    async def close(self) -> None:
        await self._http.aclose()


@pytest.fixture
async def mailpit(infra: Infra) -> AsyncIterator[MailpitApi]:
    api = MailpitApi(infra.mailpit.api_url)
    yield api
    await api.close()

"""Montagem do serviço: conexões, topologia, consumidor do Kafka e workers.

Tudo roda num processo só, no mesmo event loop da API, menos a geração dos
PDFs, que vai para o pool de processos (`render/pool.py`):

| Peça | Lê | Escreve |
| --- | --- | --- |
| consumidor do Kafka | `order.events` | `tickets` (render), `notifications` (cancelamento) |
| worker de PDF (`RENDER_WORKERS` consumidores, prefetch 1) | `tickets.render` | `notifications` (ingresso) |
| worker de e-mail (prefetch `EMAIL_PREFETCH`) | `notifications.email` | SMTP, `notifications.retry` e `.dlx` |
| monitor das DLQs | profundidade das DLQs | métrica `notifications_dlq_depth` |

Um processo só é o bastante: o trabalho de CPU já está fora do event loop, e o
resto é espera de rede. Para mais vazão, sobe mais de uma instância: o consumer
group divide as partições do Kafka e as filas dividem as tarefas.

Subida: conecta no RabbitMQ (tentando até conseguir), declara a topologia,
liga os workers e, em segundo plano, o consumidor do Kafka. Parada, na ordem
inversa do fluxo: primeiro o Kafka para de criar tarefas, depois os workers
terminam o que têm em mãos, e só então as conexões fecham.
"""

import asyncio
import contextlib
import logging
from dataclasses import dataclass

import aio_pika
import httpx
from aio_pika.abc import AbstractRobustConnection
from redis.asyncio import Redis

from notification.clients.buyers import BuyerDirectory
from notification.clients.shows import ShowDirectory
from notification.config import Settings
from notification.dedupe import Dedupe
from notification.dlq import DlqMonitor
from notification.kafka.consumer import OrderEventsConsumer
from notification.kafka.dead_letter import DeadLetterPublisher
from notification.mail.sender import SmtpSender
from notification.rabbit import topology
from notification.rabbit.publisher import Publisher
from notification.rabbit.worker import QueueWorker
from notification.render.pool import RenderPool
from notification.workers.email import EmailHandler
from notification.workers.render import RenderHandler

logger = logging.getLogger(__name__)

KAFKA = "kafka"
RENDER = "render"
EMAIL = "email"
ALL_COMPONENTS = frozenset({KAFKA, RENDER, EMAIL})


@dataclass
class Components:
    """O que cada instância liga. Os testes ligam e desligam peças separadamente."""

    enabled: frozenset[str] = ALL_COMPONENTS
    kafka_retry_base_seconds: float = 0.2
    render_retry_base_seconds: float = 1.0


class NotificationService:
    def __init__(
        self,
        settings: Settings,
        *,
        http: httpx.AsyncClient | None = None,
        components: Components | None = None,
    ) -> None:
        self.settings = settings
        self._components = components or Components()
        self._own_http = http is None
        self.http = http or httpx.AsyncClient()
        self.stopping = asyncio.Event()
        self.connection: AbstractRobustConnection | None = None
        self.publisher: Publisher | None = None
        self.monitor: DlqMonitor | None = None
        self.consumer: OrderEventsConsumer | None = None
        self.redis: Redis | None = None
        self.dedupe: Dedupe | None = None
        self.workers: dict[str, QueueWorker] = {}
        self._pool: RenderPool | None = None
        self._dead_letter: DeadLetterPublisher | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._kafka_consumer_running = False

    # ------------------------------------------------------------ subida

    async def start(self) -> None:
        settings = self.settings
        self.connection = await self._connect()
        channel = await self.connection.channel()
        await topology.declare(channel, settings.retry_delays_seconds)
        await channel.close()

        self.publisher = Publisher(self.connection)
        self.redis = Redis.from_url(settings.redis_url, socket_connect_timeout=2, socket_timeout=2)
        self.dedupe = Dedupe(self.redis, ttl_seconds=settings.dedupe_ttl_seconds)
        shows = ShowDirectory(str(settings.event_service_url), self.http, ttl_seconds=settings.show_cache_seconds)

        enabled = self._components.enabled
        if RENDER in enabled:
            self._pool = RenderPool(settings.render_workers)
            await self._pool.warm_up()
            render = RenderHandler(
                shows=shows,
                publisher=self.publisher,
                pool=self._pool,
                stopping=self.stopping,
                retry_base_seconds=self._components.render_retry_base_seconds,
            )
            await self._start_worker(topology.RENDER_QUEUE, render, prefetch=1, consumers=settings.render_workers)
        if EMAIL in enabled:
            email = EmailHandler(
                buyers=BuyerDirectory(
                    token_url=settings.keycloak_token_url,
                    admin_url=settings.keycloak_admin_url,
                    client_id=settings.keycloak_client_id,
                    client_secret=settings.keycloak_client_secret,
                    http=self.http,
                    ttl_seconds=settings.buyer_cache_seconds,
                ),
                shows=shows,
                sender=SmtpSender(
                    host=settings.smtp_host,
                    port=settings.smtp_port,
                    username=settings.smtp_username,
                    password=settings.smtp_password,
                    start_tls=settings.smtp_start_tls,
                    timeout=settings.smtp_timeout_seconds,
                ),
                publisher=self.publisher,
                dedupe=self.dedupe,
                mail_from=settings.mail_from,
            )
            await self._start_worker(topology.EMAIL_QUEUE, email, prefetch=settings.email_prefetch, consumers=1)

        self.monitor = DlqMonitor(self.connection, interval=settings.dlq_poll_seconds)
        self._tasks.append(asyncio.create_task(self.monitor.run(), name="dlq-monitor"))
        if KAFKA in enabled:
            self._dead_letter = DeadLetterPublisher(settings.kafka_brokers)
            self._tasks.append(asyncio.create_task(self._run_kafka(), name="kafka-consumer"))
        logger.info("notification-service no ar", extra={"components": sorted(enabled)})

    async def _connect(self) -> AbstractRobustConnection:
        attempt = 0
        while True:
            try:
                return await aio_pika.connect_robust(
                    str(self.settings.rabbitmq_url),
                    client_properties={"connection_name": "notification-service"},
                )
            except (OSError, aio_pika.exceptions.AMQPError) as error:
                attempt += 1
                wait = min(10.0, 0.5 * 2 ** (attempt - 1))
                logger.warning(
                    "RabbitMQ indisponível na subida; tentando de novo",
                    extra={"attempt": attempt, "waitSeconds": wait, "error": f"{type(error).__name__}: {error}"},
                )
                await asyncio.sleep(wait)

    async def _start_worker(
        self, queue: str, handler: RenderHandler | EmailHandler, *, prefetch: int, consumers: int
    ) -> None:
        assert self.connection is not None
        worker = QueueWorker(
            connection=self.connection,
            queue=queue,
            handler=handler,
            prefetch=prefetch,
            consumers=consumers,
            retry_delays_seconds=self.settings.retry_delays_seconds,
        )
        await worker.start()
        self.workers[queue] = worker

    async def _run_kafka(self) -> None:
        """Mantém o consumidor do Kafka de pé: sem Kafka, a API e os workers seguem."""
        assert self.publisher is not None
        assert self.dedupe is not None
        assert self._dead_letter is not None
        attempt = 0
        while not self.stopping.is_set():
            consumer = OrderEventsConsumer(
                settings=self.settings,
                publisher=self.publisher,
                dedupe=self.dedupe,
                dead_letter=self._dead_letter,
                retry_base_seconds=self._components.kafka_retry_base_seconds,
            )
            self.consumer = consumer
            try:
                await consumer.start()
                attempt = 0
                self._kafka_consumer_running = True
                await consumer.run()
            except asyncio.CancelledError:
                raise
            except Exception:
                attempt += 1
                logger.warning("Consumidor do Kafka parou; reiniciando", extra={"attempt": attempt}, exc_info=True)
            finally:
                self._kafka_consumer_running = False
                await consumer.close()
            if not self.stopping.is_set():
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.stopping.wait(), timeout=min(10.0, 0.5 * 2 ** max(attempt - 1, 0)))

    # ------------------------------------------------------------ estado

    @property
    def kafka_consuming(self) -> bool:
        return self._kafka_consumer_running

    @property
    def rabbitmq_connected(self) -> bool:
        return self.connection is not None and not self.connection.is_closed

    # ------------------------------------------------------------ parada

    async def stop_worker(self, queue: str) -> None:
        worker = self.workers.pop(queue, None)
        if worker is not None:
            await worker.stop()

    async def stop(self) -> None:
        self.stopping.set()
        if self.consumer is not None:
            self.consumer.request_stop()
        for task in self._tasks:
            if task.get_name() == "kafka-consumer":
                await asyncio.gather(task, return_exceptions=True)
        for queue in list(self.workers):
            await self.stop_worker(queue)
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        if self.monitor is not None:
            await self.monitor.close()
        if self._dead_letter is not None:
            await self._dead_letter.stop()
        if self.publisher is not None:
            await self.publisher.close()
        if self.connection is not None:
            await self.connection.close()
        if self.redis is not None:
            await self.redis.aclose()
        if self._pool is not None:
            self._pool.close()
        if self._own_http:
            await self.http.aclose()

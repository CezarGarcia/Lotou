"""Containers das dependências reais, com as mesmas imagens do Compose.

O módulo de Kafka do testcontainers-python só conhece a imagem da Confluent, e
o de RabbitMQ depende do pika; os daqui sobem `apache/kafka` em modo KRaft,
`rabbitmq` com o plugin de management, `redis` e o Mailpit, e esperam cada um
ficar pronto de verdade.
"""

import io
import re
import tarfile
import time

import httpx
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy

KAFKA_IMAGE = "apache/kafka:4.2.0"
RABBITMQ_IMAGE = "rabbitmq:4.2-management-alpine"
REDIS_IMAGE = "redis:8.8-alpine"
MAILPIT_IMAGE = "axllent/mailpit:v1.29"


class KafkaKraft(DockerContainer):
    """Um broker que também é controller. O endereço anunciado só se sabe depois de
    publicar a porta, então o container espera um script com ele para subir o Kafka."""

    PORT = 9094
    SCRIPT = "/tmp/tc-start.sh"

    def __init__(self, image: str = KAFKA_IMAGE) -> None:
        super().__init__(image)
        self.with_exposed_ports(self.PORT)
        env = {
            "KAFKA_NODE_ID": "1",
            "KAFKA_PROCESS_ROLES": "broker,controller",
            "KAFKA_LISTENERS": "INTERNAL://:9092,EXTERNAL://:9094,CONTROLLER://:9093",
            "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP": "INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT",
            "KAFKA_INTER_BROKER_LISTENER_NAME": "INTERNAL",
            "KAFKA_CONTROLLER_LISTENER_NAMES": "CONTROLLER",
            "KAFKA_CONTROLLER_QUORUM_VOTERS": "1@localhost:9093",
            "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR": "1",
            "KAFKA_OFFSETS_TOPIC_NUM_PARTITIONS": "1",
            "KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR": "1",
            "KAFKA_TRANSACTION_STATE_LOG_MIN_ISR": "1",
            "KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS": "0",
            # Como no Compose: tópico só existe se for criado de propósito.
            "KAFKA_AUTO_CREATE_TOPICS_ENABLE": "false",
        }
        for key, value in env.items():
            self.with_env(key, value)
        self.with_command(f'sh -c "while [ ! -f {self.SCRIPT} ]; do sleep 0.1; done; . {self.SCRIPT}"')

    def start(self) -> "KafkaKraft":
        super().start()
        host, port = self.get_container_host_ip(), self.get_exposed_port(self.PORT)
        script = (
            f"export KAFKA_ADVERTISED_LISTENERS=INTERNAL://localhost:9092,EXTERNAL://{host}:{port}\n"
            "exec /etc/kafka/docker/run\n"
        ).encode()
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as tar:
            info = tarfile.TarInfo(name=self.SCRIPT.lstrip("/"))
            info.size = len(script)
            info.mode = 0o755
            tar.addfile(info, io.BytesIO(script))
        archive.seek(0)
        self.get_wrapped_container().put_archive("/", archive)
        LogMessageWaitStrategy(re.compile(r"Kafka Server started")).with_startup_timeout(90).wait_until_ready(self)
        return self

    @property
    def bootstrap_servers(self) -> str:
        return f"{self.get_container_host_ip()}:{self.get_exposed_port(self.PORT)}"


class RabbitMq(DockerContainer):
    def __init__(self, image: str = RABBITMQ_IMAGE) -> None:
        super().__init__(image)
        self.with_exposed_ports(5672, 15672)
        self.waiting_for(LogMessageWaitStrategy(re.compile("Server startup complete")).with_startup_timeout(90))

    @property
    def url(self) -> str:
        return f"amqp://guest:guest@{self.get_container_host_ip()}:{self.get_exposed_port(5672)}/"

    @property
    def management_url(self) -> str:
        return f"http://{self.get_container_host_ip()}:{self.get_exposed_port(15672)}"


class RedisServer(DockerContainer):
    def __init__(self, image: str = REDIS_IMAGE) -> None:
        super().__init__(image)
        self.with_exposed_ports(6379)
        self.waiting_for(LogMessageWaitStrategy("Ready to accept connections"))

    @property
    def url(self) -> str:
        return f"redis://{self.get_container_host_ip()}:{self.get_exposed_port(6379)}/0"


class Mailpit(DockerContainer):
    """Servidor SMTP de desenvolvimento: guarda o que recebe e expõe numa API HTTP."""

    def __init__(self, image: str = MAILPIT_IMAGE) -> None:
        super().__init__(image)
        self.with_exposed_ports(1025, 8025)

    def start(self) -> "Mailpit":
        super().start()
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                if httpx.get(f"{self.api_url}/readyz", timeout=1).status_code == 200:
                    return self
            except httpx.HTTPError:
                pass
            time.sleep(0.2)
        raise TimeoutError("o Mailpit não ficou pronto")

    @property
    def smtp_host(self) -> str:
        return self.get_container_host_ip()

    @property
    def smtp_port(self) -> int:
        return int(self.get_exposed_port(1025))

    @property
    def api_url(self) -> str:
        return f"http://{self.get_container_host_ip()}:{self.get_exposed_port(8025)}"

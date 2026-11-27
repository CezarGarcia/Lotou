"""Containers das dependências reais, com as mesmas imagens do Compose.

O Redis é o `redis-core` do Compose (`redis:8.8-alpine`): o feed usa `XADD IDMP`,
do Redis 8.6 em diante.

O módulo MongoDB do testcontainers-python sobe um mongod sem replica set, e sem
replica set não há transação; o de Kafka só conhece a imagem da Confluent. Os
dois daqui sobem `mongo:8.0` como replica set de um nó e `apache/kafka` em modo
KRaft.
"""

import io
import re
import tarfile
import time

from pymongo import MongoClient
from pymongo.errors import PyMongoError
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy

MONGO_IMAGE = "mongo:8.0"
KAFKA_IMAGE = "apache/kafka:4.2.0"
REDIS_IMAGE = "redis:8.8-alpine"


class MongoReplicaSet(DockerContainer):
    def __init__(self, image: str = MONGO_IMAGE) -> None:
        super().__init__(image)
        self.with_exposed_ports(27017)
        self.with_command("--replSet rs0 --bind_ip_all")
        self.waiting_for(LogMessageWaitStrategy(re.compile("Waiting for connections", re.IGNORECASE)))

    def start(self) -> "MongoReplicaSet":
        super().start()
        result = self.exec(
            ["mongosh", "--quiet", "--eval", "rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]})"]
        )
        if result.exit_code != 0:
            raise RuntimeError(f"rs.initiate falhou: {result.output!r}")
        self._wait_for_primary()
        return self

    def uri(self, database: str) -> str:
        # directConnection: o membro se anuncia como localhost:27017 dentro do container.
        host, port = self.get_container_host_ip(), self.get_exposed_port(27017)
        return f"mongodb://{host}:{port}/{database}?directConnection=true"

    def _wait_for_primary(self, timeout: float = 60) -> None:
        deadline = time.monotonic() + timeout
        with MongoClient(self.uri("admin"), serverSelectionTimeoutMS=2000) as client:
            while time.monotonic() < deadline:
                try:
                    if client.admin.command("hello").get("isWritablePrimary"):
                        return
                except PyMongoError:
                    pass
                time.sleep(0.5)
        raise TimeoutError("o replica set não elegeu um primário")


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


class RedisCore(DockerContainer):
    def __init__(self, image: str = REDIS_IMAGE) -> None:
        super().__init__(image)
        self.with_exposed_ports(6379)
        self.with_command("redis-server --maxmemory-policy noeviction")
        self.waiting_for(LogMessageWaitStrategy(re.compile("Ready to accept connections")))

    @property
    def url(self) -> str:
        return f"redis://{self.get_container_host_ip()}:{self.get_exposed_port(6379)}"

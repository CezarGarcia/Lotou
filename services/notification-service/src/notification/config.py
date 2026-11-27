"""Configuração por variáveis de ambiente, validada na subida.

Uma variável ausente ou inválida derruba o processo antes de ele abrir a porta,
entrar no consumer group ou declarar a topologia, com a lista do que está errado.
"""

from typing import Annotated, Literal

from pydantic import AnyUrl, Field, HttpUrl, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

PositiveSeconds = Annotated[float, Field(gt=0)]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="ignore")

    port: int = Field(default=8085, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # ---------------------------------------------------------------- Kafka
    kafka_brokers: str = Field(default="localhost:9094", min_length=1)
    kafka_group_id: str = Field(default="notification-service", min_length=1)
    # Um consumer group novo começa do fim do tópico: `order.events` não tem
    # prazo de retenção, e começar do começo mandaria e-mail de todos os pedidos
    # da história na primeira subida. Depois disso vale o offset confirmado.
    kafka_auto_offset_reset: Literal["latest", "earliest"] = "latest"
    consumer_batch_size: int = Field(default=100, ge=1, le=1000)

    # -------------------------------------------------------------- RabbitMQ
    rabbitmq_url: AnyUrl = AnyUrl("amqp://guest:guest@localhost:5672/")
    # Processos que geram PDFs ao mesmo tempo. Cada um tem o seu consumidor de
    # `tickets.render` com prefetch 1, então a fila divide a carga entre eles.
    render_workers: int = Field(default=2, ge=1, le=32)
    email_prefetch: int = Field(default=10, ge=1, le=500)
    # Esperas entre as tentativas de um e-mail (as filas `notifications.retry.10s`,
    # `.1m` e `.5m`). Os nomes ficam; os testes encurtam os tempos. Mudar um valor
    # num ambiente que já tem as filas exige apagá-las: o RabbitMQ recusa declarar
    # a mesma fila com outro `x-message-ttl`.
    retry_delays_seconds: Annotated[tuple[PositiveSeconds, PositiveSeconds, PositiveSeconds], NoDecode] = (
        10.0,
        60.0,
        300.0,
    )
    # De quanto em quanto tempo a profundidade das DLQs é lida para a métrica.
    dlq_poll_seconds: PositiveSeconds = 15.0

    # ----------------------------------------------------------------- Redis
    redis_url: str = Field(default="redis://localhost:6380", pattern=r"^rediss?://")
    # Por quanto tempo um `eventId` já tratado fica marcado. Reentrega do Kafka
    # chega em minutos; 7 dias é folga.
    dedupe_ttl_seconds: int = Field(default=7 * 24 * 3600, ge=60)

    # ---------------------------------------------------- show e comprador
    event_service_url: HttpUrl = HttpUrl("http://localhost:3000")
    show_cache_seconds: float = Field(default=60.0, ge=0)

    # Relatório financeiro (`GET /internal/v1/shows/{id}/statement`), com o token da conta de serviço.
    analytics_service_url: HttpUrl = HttpUrl("http://localhost:8084")

    keycloak_url: HttpUrl = HttpUrl("http://localhost:8180")
    keycloak_realm: str = Field(default="lotou", min_length=1)
    keycloak_client_id: str = Field(default="notification-service", min_length=1)
    keycloak_client_secret: str = Field(min_length=1)
    buyer_cache_seconds: float = Field(default=300.0, ge=0)

    # ------------------------------------------------------------------ SMTP
    smtp_host: str = Field(default="localhost", min_length=1)
    smtp_port: int = Field(default=1025, ge=1, le=65535)
    smtp_username: str | None = None
    smtp_password: str | None = None
    smtp_start_tls: bool = False
    smtp_timeout_seconds: PositiveSeconds = 10.0
    mail_from: str = Field(default="Lotou <ingressos@lotou.test>", min_length=3)

    # --------------------------------------------------------- JWT da API
    auth_issuer: str = Field(pattern=r"^https?://")
    auth_jwks_uri: HttpUrl
    auth_audience: str = Field(default="lotou-api", min_length=1)

    otel_sdk_disabled: bool = False

    @field_validator("retry_delays_seconds", mode="before")
    @classmethod
    def _split_delays(cls, value: object) -> object:
        # `RETRY_DELAYS_SECONDS=10,60,300`
        if isinstance(value, str):
            return tuple(part.strip() for part in value.split(",") if part.strip())
        return value

    @property
    def keycloak_token_url(self) -> str:
        return f"{str(self.keycloak_url).rstrip('/')}/realms/{self.keycloak_realm}/protocol/openid-connect/token"

    @property
    def keycloak_admin_url(self) -> str:
        return f"{str(self.keycloak_url).rstrip('/')}/admin/realms/{self.keycloak_realm}"

    @property
    def max_attempts(self) -> int:
        """Tentativas de um e-mail: a primeira e uma por espera de retry."""
        return len(self.retry_delays_seconds) + 1

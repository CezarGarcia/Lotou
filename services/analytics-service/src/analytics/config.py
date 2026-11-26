"""Configuração por variáveis de ambiente, validada na subida.

Uma variável ausente ou inválida derruba o processo antes de ele abrir a porta
ou entrar no consumer group, com a lista do que está errado.
"""

from functools import cached_property
from typing import Annotated, Literal

from pydantic import Field, HttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from pymongo.errors import PyMongoError
from pymongo.uri_parser import parse_uri

PositiveSeconds = Annotated[float, Field(gt=0)]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(frozen=True, extra="ignore")

    port: int = Field(default=8084, ge=1, le=65535)
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    kafka_brokers: str = Field(default="localhost:9094", min_length=1)
    # Prefixo dos consumer groups. Cada geração dos read models tem o seu grupo
    # (`analytics-service.gen-3`): veja `docs/adr/0030-replay-dos-read-models.md`.
    kafka_group_id: str = Field(default="analytics-service", min_length=1)

    mongodb_uri: str = Field(min_length=1)

    # Comparado com o `iss` do token: é a URL pública do realm.
    auth_issuer: str = Field(pattern=r"^https?://")
    auth_jwks_uri: HttpUrl
    auth_audience: str = Field(default="lotou-api", min_length=1)

    # Mensagens lidas por vez do Kafka; cada lote de uma partição vira uma transação.
    consumer_batch_size: int = Field(default=500, ge=1, le=5000)
    # Tentativas de uma mensagem que falha por erro do próprio processamento,
    # antes de ir para a DLT. Falha de infraestrutura (MongoDB fora) não conta:
    # o consumidor espera e tenta de novo, sem descartar nada.
    consumer_max_attempts: int = Field(default=5, ge=1, le=20)
    # De quanto em quanto tempo o processo confere qual geração está ativa.
    generation_poll_seconds: PositiveSeconds = 1.0
    # Quanto tempo uma geração aposentada fica de pé depois da troca, para
    # leituras em andamento e consumidores de outras instâncias terminarem.
    retired_generation_grace_seconds: float = Field(default=30.0, ge=0)
    # Por quanto tempo o `eventId` processado fica guardado. Repetição do Kafka
    # chega em minutos (reentrega de offsets não confirmados); 30 dias é folga.
    processed_events_ttl_days: int = Field(default=30, ge=1)
    # Validade do lock do replay; renovado a cada lote enquanto o replay anda.
    replay_lease_seconds: PositiveSeconds = 60.0

    otel_sdk_disabled: bool = False

    @field_validator("mongodb_uri")
    @classmethod
    def _valid_mongodb_uri(cls, value: str) -> str:
        try:
            parse_uri(value)
        except (PyMongoError, ValueError) as error:
            raise ValueError(f"URI do MongoDB inválida: {error}") from None
        return value

    @cached_property
    def mongodb_database(self) -> str:
        """Banco do caminho da URI (`.../analytics?...`), ou `analytics`."""
        return parse_uri(self.mongodb_uri).get("database") or "analytics"

"""OpenTelemetry e logs.

Traces, métricas e logs saem por OTLP (HTTP) para o OTel Collector; o destino e
os atributos do recurso vêm das variáveis padrão (`OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`). A configuração é feita no
código, antes de criar os clientes do MongoDB e do Redis e a aplicação, para que
a instrumentação do PyMongo, do Redis e do FastAPI peguem tudo.

O console recebe uma linha JSON por log, com `trace_id` e `span_id` do span
corrente, para ir do log ao trace no Grafana. CPF e e-mail não aparecem nos
eventos do Kafka e nunca são registrados aqui.
"""

import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.instrumentation.pymongo import PymongoInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from analytics.config import Settings

SERVICE_NAME = "analytics-service"

# Atributos que todo LogRecord tem; o resto veio de `extra=` e vai para o JSON.
_STANDARD_ATTRS = frozenset(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {
    "message",
    "asctime",
    "color_message",  # cópia com cores ANSI que o uvicorn põe em cada log
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        span_context = trace.get_current_span().get_span_context()
        if span_context.is_valid:
            entry["trace_id"] = format(span_context.trace_id, "032x")
            entry["span_id"] = format(span_context.span_id, "016x")
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                entry[key] = value
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, ensure_ascii=False)


@dataclass
class Telemetry:
    """Provedores criados na subida, para o desligamento enviar o último lote."""

    providers: list[Any] = field(default_factory=list)

    def shutdown(self) -> None:
        for provider in self.providers:
            provider.shutdown()
        self.providers.clear()


def configure_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level)
    # O aiokafka registra cada reconexão em WARNING; o que importa já sai nos logs do consumidor.
    logging.getLogger("aiokafka").setLevel(max(logging.getLevelName(level), logging.ERROR))
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logging.getLogger(name).handlers.clear()
        logging.getLogger(name).propagate = True


def setup(settings: Settings) -> Telemetry:
    configure_logging(settings.log_level)
    telemetry = Telemetry()
    if settings.otel_sdk_disabled:
        return telemetry

    attributes = {} if os.environ.get("OTEL_SERVICE_NAME") else {"service.name": SERVICE_NAME}
    resource = Resource.create(attributes)

    tracer_provider = TracerProvider(resource=resource)
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)

    meter_provider = MeterProvider(
        resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())]
    )
    metrics.set_meter_provider(meter_provider)

    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    logging.getLogger().addHandler(LoggingHandler(logger_provider=logger_provider))

    PymongoInstrumentor().instrument()
    RedisInstrumentor().instrument()

    telemetry.providers.extend([tracer_provider, meter_provider, logger_provider])
    return telemetry

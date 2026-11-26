"""Aplicação FastAPI: rotas, erros e o ciclo de vida do consumidor ao vivo."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from analytics.api import problems, routes
from analytics.api.auth import JwksCache, TokenVerifier
from analytics.config import Settings
from analytics.kafka.dead_letter import DeadLetterPublisher
from analytics.replay import BackgroundReplays, ReplayRunner
from analytics.store import connect
from analytics.supervisor import LiveSupervisor
from analytics.telemetry import Telemetry
from analytics.wiring import build_registry


def create_app(
    settings: Settings,
    *,
    telemetry: Telemetry | None = None,
    jwks_http: httpx.AsyncClient | None = None,
) -> FastAPI:
    """`jwks_http` deixa os testes servirem o JWKS sem rede."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client = connect(settings)
        registry = build_registry(settings, client)
        dead_letter = DeadLetterPublisher(settings.kafka_brokers)
        http = jwks_http or httpx.AsyncClient()
        supervisor = LiveSupervisor(settings=settings, client=client, registry=registry, dead_letter=dead_letter)
        replays = BackgroundReplays(
            lambda: ReplayRunner(settings=settings, client=client, registry=registry, dead_letter=dead_letter)
        )
        app.state.settings = settings
        app.state.registry = registry
        app.state.supervisor = supervisor
        app.state.replays = replays
        app.state.token_verifier = TokenVerifier(
            JwksCache(str(settings.auth_jwks_uri), http),
            issuer=settings.auth_issuer,
            audience=settings.auth_audience,
        )
        # O consumidor sobe em segundo plano: sem Kafka, a API continua lendo
        # os read models e o /health/ready diz que o consumidor está parado.
        await supervisor.start()
        try:
            yield
        finally:
            await replays.shutdown()
            await supervisor.stop()
            await dead_letter.stop()
            if jwks_http is None:
                await http.aclose()
            await client.close()
            if telemetry is not None:
                telemetry.shutdown()

    app = FastAPI(
        title="analytics-service",
        summary="Vendas, relatório financeiro e pedidos do painel do produtor, a partir dos eventos do Kafka.",
        version="1.0.0",
        lifespan=lifespan,
    )
    problems.install(app)
    app.include_router(routes.analytics)
    app.include_router(routes.internal)
    app.include_router(routes.health)
    if not settings.otel_sdk_disabled:
        # O health check roda a cada poucos segundos e não é tráfego real.
        FastAPIInstrumentor.instrument_app(app, excluded_urls="health/")
    return app

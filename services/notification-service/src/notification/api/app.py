"""Aplicação FastAPI: health check, API interna das DLQs e o ciclo de vida dos workers."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

from notification.api import problems, routes
from notification.api.auth import JwksCache, TokenVerifier
from notification.config import Settings
from notification.service import Components, NotificationService
from notification.telemetry import Telemetry


def create_app(
    settings: Settings,
    *,
    telemetry: Telemetry | None = None,
    jwks_http: httpx.AsyncClient | None = None,
    http: httpx.AsyncClient | None = None,
    components: Components | None = None,
) -> FastAPI:
    """`jwks_http` e `http` deixam os testes servirem o Keycloak e o event-service sem rede."""

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        own_jwks = jwks_http is None
        keys_http = jwks_http or httpx.AsyncClient()
        app.state.token_verifier = TokenVerifier(
            JwksCache(str(settings.auth_jwks_uri), keys_http),
            issuer=settings.auth_issuer,
            audience=settings.auth_audience,
        )
        service = NotificationService(settings, http=http, components=components)
        await service.start()
        app.state.service = service
        try:
            yield
        finally:
            await service.stop()
            if own_jwks:
                await keys_http.aclose()
            if telemetry is not None:
                telemetry.shutdown()

    app = FastAPI(
        title="notification-service",
        summary="PDF dos ingressos com QR code e e-mails do comprador, com retry e DLQ no RabbitMQ.",
        version="1.0.0",
        lifespan=lifespan,
    )
    problems.install(app)
    app.include_router(routes.internal)
    app.include_router(routes.health)
    if not settings.otel_sdk_disabled:
        # O health check roda a cada poucos segundos e não é tráfego real.
        FastAPIInstrumentor.instrument_app(app, excluded_urls="health/")
    return app

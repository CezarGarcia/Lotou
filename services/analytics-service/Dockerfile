# syntax=docker/dockerfile:1

# ---- build: instala as dependências de produção num venv, com o uv e o uv.lock ----
FROM python:3.13-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv

# Primeiro só as dependências, para a camada não mudar a cada alteração no código.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-install-project

COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --no-editable

# ---- runtime: o Python e o venv, sem o uv nem o código-fonte solto ----
FROM python:3.13-slim
RUN groupadd --system lotou && useradd --system --gid lotou --no-create-home lotou
WORKDIR /app
COPY --from=build --chown=lotou:lotou /app/.venv /app/.venv

ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONUNBUFFERED=1 \
    OTEL_SERVICE_NAME=analytics-service \
    PORT=8084

USER lotou
EXPOSE 8084

# A imagem slim não tem curl nem wget.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD ["python", "-c", "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8084\")}/health/ready', timeout=2)"]

# O OpenTelemetry é configurado no código (analytics/telemetry.py), antes do
# cliente do MongoDB e da aplicação. Replay: `python -m analytics.replay`.
CMD ["python", "-m", "analytics"]

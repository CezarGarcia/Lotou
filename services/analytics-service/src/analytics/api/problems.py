"""Erros da API em Problem Details (RFC 9457), com `type` em `urn:lotou:problem:<tipo>`.

É o único lugar que escreve uma resposta de erro, então o contrato é um só.
"""

import logging
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from opentelemetry import trace
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

PROBLEM_CONTENT_TYPE = "application/problem+json"


def problem_type(slug: str) -> str:
    return f"urn:lotou:problem:{slug}"


class ProblemError(Exception):
    def __init__(
        self,
        status: HTTPStatus,
        slug: str,
        title: str,
        detail: str | None = None,
        *,
        errors: list[dict[str, str]] | None = None,
        headers: dict[str, str] | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(detail or title)
        self.status = status
        self.slug = slug
        self.title = title
        self.detail = detail
        self.errors = errors
        self.headers = headers or {}
        self.extra = extra or {}


def unauthorized(detail: str) -> ProblemError:
    return ProblemError(
        HTTPStatus.UNAUTHORIZED, "unauthorized", "Não autenticado", detail, headers={"WWW-Authenticate": "Bearer"}
    )


def forbidden() -> ProblemError:
    return ProblemError(
        HTTPStatus.FORBIDDEN, "forbidden", "Acesso negado", "Seu usuário não tem permissão para esta operação."
    )


def not_found(resource: str) -> ProblemError:
    return ProblemError(HTTPStatus.NOT_FOUND, "not-found", "Recurso não encontrado", f"{resource} não encontrado.")


def validation(errors: list[dict[str, str]]) -> ProblemError:
    return ProblemError(
        HTTPStatus.BAD_REQUEST,
        "validation-error",
        "Requisição inválida",
        "Um ou mais campos da requisição são inválidos.",
        errors=errors,
    )


def unavailable(detail: str) -> ProblemError:
    return ProblemError(
        HTTPStatus.SERVICE_UNAVAILABLE,
        "service-unavailable",
        "Serviço indisponível",
        detail,
        headers={"Retry-After": "5"},
    )


def _response(request: Request, body: dict[str, Any], headers: dict[str, str] | None = None) -> JSONResponse:
    body["instance"] = request.url.path
    span_context = trace.get_current_span().get_span_context()
    if span_context.is_valid:
        body["traceId"] = format(span_context.trace_id, "032x")
    return JSONResponse(body, status_code=body["status"], headers=headers, media_type=PROBLEM_CONTENT_TYPE)


async def _problem(request: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, ProblemError)
    body: dict[str, Any] = {"type": problem_type(error.slug), "title": error.title, "status": int(error.status)}
    if error.detail:
        body["detail"] = error.detail
    if error.errors:
        body["errors"] = error.errors
    body.update(error.extra)
    return _response(request, body, error.headers)


async def _validation(request: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, RequestValidationError)
    violations = [
        {
            # `loc` vem como ("path", "showId") ou ("query", "limit"): o primeiro item é a origem.
            "field": ".".join(str(part) for part in item["loc"][1:]) or str(item["loc"][0]),
            "message": item["msg"],
        }
        for item in error.errors()
    ]
    return await _problem(request, validation(violations))


async def _http(request: Request, error: Exception) -> JSONResponse:
    assert isinstance(error, StarletteHTTPException)
    status = HTTPStatus(error.status_code)
    body: dict[str, Any] = {"type": "about:blank", "title": status.phrase, "status": status.value}
    if status < 500 and error.detail:
        body["detail"] = str(error.detail)
    return _response(request, body, dict(error.headers or {}))


async def _unexpected(request: Request, error: Exception) -> JSONResponse:
    # O detalhe vai para o log, nunca para o cliente.
    logger.exception("Erro não tratado na requisição", exc_info=error)
    body: dict[str, Any] = {
        "type": "about:blank",
        "title": HTTPStatus.INTERNAL_SERVER_ERROR.phrase,
        "status": 500,
        "detail": "Erro interno. Tente novamente em instantes.",
    }
    return _response(request, body)


def install(app: FastAPI) -> None:
    app.add_exception_handler(ProblemError, _problem)
    app.add_exception_handler(RequestValidationError, _validation)
    app.add_exception_handler(StarletteHTTPException, _http)
    app.add_exception_handler(Exception, _unexpected)

import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';

/** Erro da API no formato Problem Details (RFC 9457). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** ID do trace da requisição, para o suporte achar o erro no Tempo. */
  traceId?: string;
  errors?: { field: string; message: string }[];
  /** Membros de extensão, como `available` ou `seats`. */
  [extension: string]: unknown;
}

/** O que a tela mostra quando uma chamada falha. */
export interface ApiError {
  status: number;
  message: string;
  traceId?: string;
  /** Tipo do problema sem o prefixo: `urn:lotou:problem:sold-out` vira `sold-out`. */
  code?: string;
  /** Membros de extensão do problema (`available`, `seats`, `remaining`, `errors`...). */
  details?: Record<string, unknown>;
  /** Quanto esperar antes de tentar de novo, lido do cabeçalho `Retry-After`. */
  retryAfterSeconds?: number;
}

const PROBLEM_PREFIX = 'urn:lotou:problem:';
const STANDARD_MEMBERS = new Set(['type', 'title', 'status', 'detail', 'instance', 'traceId']);

const isProblem = (body: unknown): body is ProblemDetails =>
  typeof body === 'object' && body !== null && 'status' in body && 'title' in body;

/** `Retry-After` em segundos ou como data HTTP. */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - nowMs) / 1000));
}

/**
 * Converte uma resposta de erro (status, corpo e cabeçalhos) em `ApiError`.
 * Serve ao `HttpClient` e ao leitor de SSE, que usa `fetch` direto.
 */
export function problemToApiError(
  status: number,
  body: unknown,
  headers?: Pick<HttpHeaders, 'get'> | Pick<Headers, 'get'>,
): ApiError {
  const retryAfterSeconds = parseRetryAfter(headers?.get('Retry-After'));
  const extra = retryAfterSeconds === undefined ? {} : { retryAfterSeconds };
  if (!isProblem(body)) {
    return { status, message: 'Não foi possível concluir a operação.', ...extra };
  }
  const { title, detail, traceId, type } = body;
  const details = Object.fromEntries(
    Object.entries(body).filter(([name]) => !STANDARD_MEMBERS.has(name)),
  );
  return {
    status: body.status,
    message: detail ?? title,
    ...(traceId ? { traceId } : {}),
    ...(type?.startsWith(PROBLEM_PREFIX) ? { code: type.slice(PROBLEM_PREFIX.length) } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...extra,
  };
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return { status: 0, message: 'Sem conexão com o servidor. Confira sua internet.' };
    }
    return problemToApiError(error.status, error.error, error.headers);
  }
  if (isApiError(error)) {
    return error;
  }
  return { status: 0, message: 'Algo deu errado. Tente novamente.' };
}

export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ApiError).status === 'number' &&
    typeof (value as ApiError).message === 'string'
  );
}

/** Falha passageira: sem rede, servidor fora do ar, limite de taxa ou estoque ainda carregando. */
export function isTransient(error: ApiError): boolean {
  return (
    error.status === 0 ||
    error.status === 408 ||
    error.status === 429 ||
    error.status >= 500 ||
    error.code === 'inventory-loading'
  );
}

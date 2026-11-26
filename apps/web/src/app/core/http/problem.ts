import { HttpErrorResponse } from '@angular/common/http';

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
}

/** O que a tela mostra quando uma chamada falha. */
export interface ApiError {
  status: number;
  message: string;
  traceId?: string;
}

const isProblem = (body: unknown): body is ProblemDetails =>
  typeof body === 'object' && body !== null && 'status' in body && 'title' in body;

export function toApiError(error: unknown): ApiError {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) {
      return { status: 0, message: 'Sem conexão com o servidor. Confira sua internet.' };
    }
    if (isProblem(error.error)) {
      const { status, title, detail, traceId } = error.error;
      return { status, message: detail ?? title, traceId };
    }
    return { status: error.status, message: 'Não foi possível concluir a operação.' };
  }
  return { status: 0, message: 'Algo deu errado. Tente novamente.' };
}

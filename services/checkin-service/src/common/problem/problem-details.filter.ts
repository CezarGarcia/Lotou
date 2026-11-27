import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';
import {
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  ProblemException,
} from './problem.js';

/**
 * Converte toda exceção em Problem Details (RFC 9457). É o único lugar do
 * serviço que escreve uma resposta de erro, então o contrato é um só.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const problem = this.toProblem(exception);
    problem.instance = request.originalUrl.split('?')[0];
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    if (traceId) {
      problem.traceId = traceId;
    }

    if (exception instanceof ProblemException) {
      response.set(exception.headers);
    }
    response
      .status(problem.status)
      .type(PROBLEM_CONTENT_TYPE)
      .send(JSON.stringify(problem));
  }

  private toProblem(exception: unknown): ProblemDetails {
    if (exception instanceof ProblemException) {
      return { ...exception.problem };
    }

    // Exceções HTTP do próprio Nest (rota inexistente, corpo malformado etc.).
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'about:blank',
        title: STATUS_CODES[status] ?? 'Error',
        status,
        ...(status < 500 && { detail: exception.message }),
      };
    }

    // Erro inesperado: o detalhe vai para o log, nunca para o cliente.
    this.logger.error(
      exception instanceof Error ? exception.message : 'Erro não tratado',
      exception instanceof Error ? exception.stack : undefined,
    );
    return {
      type: 'about:blank',
      title: STATUS_CODES[HttpStatus.INTERNAL_SERVER_ERROR]!,
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      detail: 'Erro interno. Tente novamente em instantes.',
    };
  }
}

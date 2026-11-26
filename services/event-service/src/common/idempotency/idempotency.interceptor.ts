import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  type NestInterceptor,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { type Observable, catchError, concatMap, from, of } from 'rxjs';
import type { RequestWithUser } from '../../auth/auth.decorators.js';
import { ProblemException, Problems } from '../problem/problem.js';
import { IdempotencyStore } from './idempotency.store.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

// Caracteres visíveis de ASCII, como no rascunho da IETF para o cabeçalho.
const VALID_KEY = /^[\x21-\x7e]{1,255}$/;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Torna um POST seguro para repetição. A primeira requisição com uma
 * `Idempotency-Key` executa; as repetições recebem a mesma resposta, sem
 * criar o recurso de novo (clique duplo, retry após timeout).
 *
 * - Sem o cabeçalho: 400.
 * - Mesma chave com outro corpo: 422.
 * - Mesma chave ainda em processamento: 409.
 *
 * As chaves ficam no MongoDB com TTL de 24 h (ADR 22). A chave vale por
 * usuário e por rota, então dois usuários podem usar a mesma chave.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly store: IdempotencyStore) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const response = http.getResponse<Response>();

    const key = request.header(IDEMPOTENCY_HEADER);
    if (!key || !VALID_KEY.test(key)) {
      throw Problems.validation([
        {
          field: IDEMPOTENCY_HEADER,
          message: key
            ? 'Use de 1 a 255 caracteres ASCII visíveis'
            : 'Cabeçalho obrigatório em requisições que criam recursos',
        },
      ]);
    }

    const route = `${request.method} ${request.baseUrl}${(request.route as { path: string }).path}`;
    const recordId = sha256(
      [request.user?.id ?? 'anonymous', route, key].join('\n'),
    );
    const requestHash = sha256(JSON.stringify(request.body ?? null));

    const outcome = await this.store.begin(recordId, requestHash);
    switch (outcome.kind) {
      case 'replay':
        response.setHeader(REPLAYED_HEADER, 'true');
        if (outcome.response.location) {
          response.location(outcome.response.location);
        }
        return of(outcome.response.body);

      case 'mismatch':
        throw new ProblemException({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          slug: 'idempotency-key-reused',
          title: 'Idempotency-Key reutilizada',
          detail:
            'Esta Idempotency-Key já foi usada com um corpo diferente. Gere uma chave nova para cada operação.',
        });

      case 'in-progress':
        throw new ProblemException({
          status: HttpStatus.CONFLICT,
          slug: 'request-in-progress',
          title: 'Requisição em andamento',
          detail:
            'Uma requisição com esta Idempotency-Key ainda está sendo processada. Tente de novo em instantes.',
        });

      case 'started':
        return next.handle().pipe(
          concatMap(async (body: unknown) => {
            const location = response.getHeader('location');
            await this.store.complete(recordId, {
              body,
              location: typeof location === 'string' ? location : undefined,
            });
            return body;
          }),
          catchError((error: unknown) =>
            from(
              this.store.release(recordId).then(() => {
                throw error;
              }),
            ),
          ),
        );
    }
  }
}

/** Marca um POST que cria recurso: exige e respeita a `Idempotency-Key`. */
export const Idempotent = () => UseInterceptors(IdempotencyInterceptor);

import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import type { RequestWithUser } from '../auth/auth.decorators.js';
import { ProblemException } from '../common/problem/problem.js';
import {
  type RateLimitDecision,
  SlidingWindowLimiter,
} from './sliding-window.limiter.js';

/**
 * De quem é a cota: do usuário, quando o token é válido; senão, do IP. O IP
 * entra como hash, nunca cru, para não guardar dado pessoal no Redis.
 */
export function rateLimitSubject(
  userId: string | undefined,
  ip: string | undefined,
): string {
  if (userId) {
    return userId;
  }
  const hash = createHash('sha256')
    .update(ip ?? 'desconhecido')
    .digest('hex');
  return `ip:${hash}`;
}

/**
 * Aplica o rate limit nas leituras públicas do catálogo. Roda depois do guard
 * global de autenticação, que já validou o token e preencheu o usuário.
 *
 * Toda resposta leva `RateLimit-Limit` e `RateLimit-Remaining`; acima do
 * limite, 429 com `Retry-After`. Com o Redis fora, deixa passar (fail open):
 * o rate limit protege o serviço, e derrubar as leituras por falta dele seria
 * pior que ficar sem ele por um tempo.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(private readonly limiter: SlidingWindowLimiter) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.limiter.enabled) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<RequestWithUser>();
    const response = http.getResponse<Response>();

    let decision: RateLimitDecision;
    try {
      decision = await this.limiter.hit(
        rateLimitSubject(request.user?.id, request.ip),
      );
    } catch (error) {
      this.logger.debug(`Rate limit indisponível: ${String(error)}`);
      return true;
    }

    response.setHeader('RateLimit-Limit', decision.limit);
    response.setHeader('RateLimit-Remaining', decision.remaining);
    if (decision.allowed) {
      return true;
    }
    const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    throw new ProblemException({
      status: HttpStatus.TOO_MANY_REQUESTS,
      slug: 'rate-limited',
      title: 'Muitas requisições',
      detail: `Limite de ${decision.limit} requisições atingido. Tente de novo em ${retryAfter} s.`,
      headers: { 'Retry-After': String(retryAfter) },
    });
  }
}

/** Liga o rate limit numa rota ou num controller. */
export const RateLimited = () => UseGuards(RateLimitGuard);

import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis, Result } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Env } from '../config/env.js';
import { REDIS_CORE } from '../redis/redis.client.js';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    slidingWindowHit(
      key: string,
      windowMs: number,
      max: number,
      member: string,
    ): Result<[number, number, number], Context>;
  }
}

// Um sorted set por sujeito, com um membro por requisição aceita e a hora
// dela como score. Tudo num script, para que duas requisições simultâneas não
// leiam a mesma contagem e passem as duas. A hora vem do Redis: instâncias
// com relógios diferentes contam na mesma régua.
//
// Requisição recusada não entra no set; senão, quem insiste ficaria bloqueado
// para sempre.
//
// Devolve {aceita (1 ou 0), restantes, ms até o membro mais velho sair}.
const HIT_SCRIPT = `
local window = tonumber(ARGV[1])
local max = tonumber(ARGV[2])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < max then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  return {1, max - count - 1, 0}
end

local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}
`;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Quanto falta para caber mais uma requisição; zero se foi aceita. */
  retryAfterMs: number;
}

/**
 * Rate limit por janela deslizante, feito à mão no `redis-core` (chave
 * `rl:{sujeito}`). O gateway usa token bucket; os dois ficam lado a lado para
 * comparar (seção "Outros usos do Redis" de docs/projeto.md).
 *
 * Diferente da janela fixa, não deixa passar o dobro do limite na virada de
 * uma janela para a outra. O custo é um membro por requisição na memória.
 */
@Injectable()
export class SlidingWindowLimiter {
  readonly enabled: boolean;
  private readonly max: number;
  private readonly windowMs: number;

  constructor(
    @Inject(REDIS_CORE) private readonly redis: Redis,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('RATE_LIMIT_ENABLED', { infer: true });
    this.max = config.get('RATE_LIMIT_MAX', { infer: true });
    this.windowMs = config.get('RATE_LIMIT_WINDOW_MS', { infer: true });
    redis.defineCommand('slidingWindowHit', {
      numberOfKeys: 1,
      lua: HIT_SCRIPT,
    });
  }

  /** Conta uma requisição de `subject`, se ainda couber na janela. */
  async hit(subject: string): Promise<RateLimitDecision> {
    const [allowed, remaining, retryAfterMs] =
      await this.redis.slidingWindowHit(
        `rl:${subject}`,
        this.windowMs,
        this.max,
        randomUUID(),
      );
    return {
      allowed: allowed === 1,
      limit: this.max,
      remaining,
      retryAfterMs,
    };
  }
}

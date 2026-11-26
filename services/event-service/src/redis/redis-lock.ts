import type { Redis, Result } from 'ioredis';
import { randomUUID } from 'node:crypto';

declare module 'ioredis' {
  interface RedisCommander<Context> {
    releaseLock(key: string, token: string): Result<number, Context>;
  }
}

// Apaga só se o lock ainda for de quem o pegou. Sem a comparação, quem demorou
// mais que o TTL apagaria o lock que outra requisição pegou depois.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Lock com `SET NX PX` e um token por dono. O TTL libera o lock de quem
 * morreu sem soltá-lo. Não garante exclusão forte (uma pausa longa do
 * processo passa do TTL): serve para evitar trabalho repetido, não para
 * proteger um invariante.
 */
export class RedisLock {
  constructor(private readonly redis: Redis) {
    redis.defineCommand('releaseLock', {
      numberOfKeys: 1,
      lua: RELEASE_SCRIPT,
    });
  }

  /** O token do lock, ou `null` se outro já o segura. */
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return acquired === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.releaseLock(key, token);
  }
}

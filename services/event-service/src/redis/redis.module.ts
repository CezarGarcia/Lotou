import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { Env } from '../config/env.js';
import {
  closeRedisClient,
  createRedisClient,
  REDIS_CACHE,
  REDIS_CORE,
} from './redis.client.js';

/**
 * Uma conexão por instância do Redis: `redis-cache` pode perder dados e
 * `redis-core` não pode. Cada comando vira um span pela instrumentação do
 * ioredis, já ligada em `instrumentation.ts`.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CACHE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createRedisClient(
          config.get('REDIS_CACHE_URL', { infer: true }),
          'cache',
        ),
    },
    {
      provide: REDIS_CORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createRedisClient(
          config.get('REDIS_CORE_URL', { infer: true }),
          'core',
        ),
    },
  ],
  exports: [REDIS_CACHE, REDIS_CORE],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(
    @Inject(REDIS_CACHE) private readonly cache: Redis,
    @Inject(REDIS_CORE) private readonly core: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([
      closeRedisClient(this.cache),
      closeRedisClient(this.core),
    ]);
  }
}

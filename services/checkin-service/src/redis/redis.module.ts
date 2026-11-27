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
  REDIS_CORE,
} from './redis.client.js';

/**
 * Conexão com o `redis-core`, que guarda `checkin:{ticketId}`. Cada comando
 * vira um span pela instrumentação do ioredis, ligada em `instrumentation.ts`.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createRedisClient(config.get('REDIS_URL', { infer: true }), 'core'),
    },
  ],
  exports: [REDIS_CORE],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CORE) private readonly core: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await closeRedisClient(this.core);
  }
}

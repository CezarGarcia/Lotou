import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg, { type Pool } from 'pg';
import type { Env } from '../config/env.js';
import { connectionString } from './connection-string.js';
import { migrate } from './migrate.js';

/** Token de injeção do pool de conexões com o banco `payments`. */
export const PG_POOL = Symbol('PG_POOL');

@Injectable()
class PoolShutdown implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Depois do consumidor e do relay, que param antes (beforeApplicationShutdown). */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Pool do Postgres. A subida aplica as migrações antes de qualquer outro
 * módulo usar o banco: o consumidor e o relay só começam depois.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: async (config: ConfigService<Env, true>) => {
        const logger = new Logger('Database');
        const pool = new pg.Pool({
          connectionString: connectionString(
            config.get('DATABASE_URL', { infer: true }),
            config.get('DATABASE_PASSWORD', { infer: true }),
          ),
          max: config.get('DATABASE_POOL_MAX', { infer: true }),
          application_name: 'payment-mock',
          // Falha rápido com o banco fora, em vez de segurar o consumidor.
          connectionTimeoutMillis: 3_000,
          // Teto de cada comando; o mais lento é o lock do outbox.
          statement_timeout: 10_000,
        });
        // Uma conexão ociosa que cai (Postgres reiniciou) emite `error` no
        // pool; sem ouvinte, o processo inteiro cairia.
        pool.on('error', (error) =>
          logger.warn(`Conexão ociosa com o Postgres caiu: ${error.message}`),
        );

        const applied = await migrate(pool);
        if (applied.length > 0) {
          logger.log(`Migrações aplicadas: ${applied.join(', ')}`);
        }
        return pool;
      },
    },
    PoolShutdown,
  ],
  exports: [PG_POOL],
})
export class DatabaseModule {}

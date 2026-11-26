import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module.js';
import { KAFKA_ADMIN } from '../kafka/kafka.module.js';
import { TOPICS } from '../kafka/topics.js';

const CHECK_TIMEOUT_MS = 1_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`sem resposta em ${ms} ms`)),
        ms,
      ).unref(),
    ),
  ]);
}

/**
 * O serviço não tem API: só o health check, para o Compose e o orquestrador
 * saberem se ele está de pé.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(KAFKA_ADMIN) private readonly admin: KafkaJS.Admin,
  ) {}

  /** O processo está vivo? Não olha as dependências: reiniciar não as consertaria. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /**
   * O serviço consegue trabalhar agora? Falha se o Postgres não responde ou se
   * o broker não responde com os tópicos do serviço.
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.check('postgres', () => this.pool.query('SELECT 1')),
      () =>
        this.check('kafka', () =>
          this.admin.fetchTopicMetadata({
            topics: [TOPICS.commands, TOPICS.events, TOPICS.commandsDlt],
            timeout: CHECK_TIMEOUT_MS,
          }),
        ),
    ]);
  }

  private async check(key: string, probe: () => Promise<unknown>) {
    const indicator = this.indicators.check(key);
    try {
      await withTimeout(probe(), CHECK_TIMEOUT_MS);
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: (error as Error).message });
    }
  }
}

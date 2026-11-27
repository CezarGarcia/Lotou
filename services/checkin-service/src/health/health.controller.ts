import { Controller, Get, Inject } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { Pool } from 'pg';
import { Public } from '../auth/auth.decorators.js';
import { PG_POOL } from '../database/database.module.js';

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

/** Health check, para o Compose e o orquestrador saberem se o serviço está de pé. */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: HealthIndicatorService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /** O processo está vivo? Não olha as dependências: reiniciar não as consertaria. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /**
   * O serviço consegue atender a portaria agora? Só o Postgres decide: a
   * leitura do QR funciona sem o Kafka (as entradas esperam no outbox) e sem o
   * Redis (a constraint única decide quem entrou primeiro). Tirar a portaria
   * do ar por causa deles pararia a fila na porta do show sem motivo.
   */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.check('postgres', () => this.pool.query('SELECT 1')),
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

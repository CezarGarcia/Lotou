import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { envSchema } from '../../src/config/env.js';
import { PG_POOL } from '../../src/database/database.module.js';
import { OutboxRelay } from '../../src/outbox/outbox.relay.js';
import { PaymentMetrics } from '../../src/payments/payment-metrics.js';
import { PaymentsService } from '../../src/payments/payments.service.js';
import { RANDOM_SOURCE } from '../../src/payments/simulated-gateway.js';

/**
 * O sorteio do gateway, controlado pelo teste. Com taxa de recusa e de falha
 * de estorno em 0,5, `approve()` faz o próximo sorteio aprovar (e estornar) e
 * `decline()` faz recusar (e falhar o estorno). Sem latência sorteada, cada
 * decisão usa um número (e a recusa, mais um para o motivo).
 */
export class Draws {
  private value = 0.9;

  readonly source = () => this.value;

  /** Aprova a autorização e conclui o estorno. */
  approve(): void {
    this.value = 0.9;
  }

  /** Recusa a autorização (motivo INSUFFICIENT_FUNDS) e falha o estorno. */
  decline(): void {
    this.value = 0.1;
  }
}

export interface TestApp {
  app: INestApplication;
  pool: Pool;
  relay: OutboxRelay;
  payments: PaymentsService;
  metrics: PaymentMetrics;
  draws: Draws;
  close(): Promise<void>;
}

/**
 * A aplicação real, com o AppModule inteiro, o Postgres e o Kafka do
 * Testcontainers. A única troca é a fonte de números do gateway.
 */
export async function createTestApp(
  env: Record<string, string> = {},
): Promise<TestApp> {
  const draws = new Draws();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ConfigService)
    .useValue(
      new ConfigService(
        envSchema.parse({
          ...process.env,
          DECLINE_RATE: '0.5',
          REFUND_FAILURE_RATE: '0.5',
          ...env,
        }),
      ),
    )
    .overrideProvider(RANDOM_SOURCE)
    .useValue(draws.source)
    .compile();

  // Sem logs, a menos que TEST_LOGS=1 (veja quiet-logs.ts).
  const app = moduleRef.createNestApplication(
    process.env.TEST_LOGS ? {} : { logger: false },
  );
  await app.init();
  return {
    app,
    pool: app.get(PG_POOL),
    relay: app.get(OutboxRelay),
    payments: app.get(PaymentsService),
    metrics: app.get(PaymentMetrics),
    draws,
    close: () => app.close(),
  };
}

/** As linhas de uma tabela do pedido, para conferir o que foi gravado. */
export async function paymentsOf(pool: Pool, orderId: string) {
  const { rows } = await pool.query(
    'SELECT * FROM payments WHERE order_id = $1',
    [orderId],
  );
  return rows;
}

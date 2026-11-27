import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { setupApp } from '../../src/app.setup.js';
import type { Role } from '../../src/auth/authenticated-user.js';
import { JWT_KEY_SET } from '../../src/auth/token-verifier.js';
import { RejectionBuffer } from '../../src/checkin/rejection-buffer.js';
import { envSchema } from '../../src/config/env.js';
import { PG_POOL } from '../../src/database/database.module.js';
import { OutboxRelay } from '../../src/outbox/outbox.relay.js';
import { REDIS_CORE } from '../../src/redis/redis.client.js';
import { createTestIssuer, type TestIssuer } from './auth.js';

export interface ApiClient {
  get(url: string): request.Test;
  post(url: string, body?: object): request.Test;
}

export interface TestApp {
  app: INestApplication<App>;
  issuer: TestIssuer;
  pool: Pool;
  redis: Redis;
  relay: OutboxRelay;
  rejections: RejectionBuffer;
  /** Cliente HTTP sem token. */
  anonymous: ApiClient;
  /** Cliente HTTP de um usuário com os papéis informados (`sub` opcional). */
  as(roles: Role[], sub?: string): Promise<ApiClient>;
  close(): Promise<void>;
}

/**
 * A aplicação real, com o AppModule inteiro e o Postgres, o Redis e o Kafka
 * do Testcontainers. A única troca é o conjunto de chaves do emissor de
 * tokens, que é local.
 */
export async function createTestApp(
  env: Record<string, string> = {},
): Promise<TestApp> {
  const issuer = await createTestIssuer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JWT_KEY_SET)
    .useValue(issuer.keySet)
    // O ConfigModule lê o ambiente uma vez, ao importar o AppModule; aqui a
    // configuração é refeita com a mesma validação da subida.
    .overrideProvider(ConfigService)
    .useValue(new ConfigService(envSchema.parse({ ...process.env, ...env })))
    .compile();

  // Sem logs, a menos que TEST_LOGS=1 (veja quiet-logs.ts).
  const app = setupApp(
    moduleRef.createNestApplication<INestApplication<App>>(
      process.env.TEST_LOGS ? {} : { logger: false },
    ),
  );
  await app.init();

  const client = (token?: string): ApiClient => {
    const authorize = (test: request.Test) =>
      token ? test.set('Authorization', `Bearer ${token}`) : test;
    const http = () => request(app.getHttpServer());
    return {
      get: (url) => authorize(http().get(url)),
      post: (url, body = {}) => authorize(http().post(url)).send(body),
    };
  };

  return {
    app,
    issuer,
    pool: app.get(PG_POOL),
    redis: app.get(REDIS_CORE),
    relay: app.get(OutboxRelay),
    rejections: app.get(RejectionBuffer),
    anonymous: client(),
    as: async (roles, sub) => client(await issuer.token({ roles, sub })),
    close: () => app.close(),
  };
}

/** Espera a condição ficar verdadeira (a cópia local chega pelo Kafka). */
export async function eventually<T>(
  probe: () => Promise<T | undefined | null | false>,
  what: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Esperava ${what} em ${timeoutMs} ms`);
    }
    await sleep(50);
  }
}

/** O estado do ingresso na cópia local, ou `undefined` se ainda não chegou. */
export async function ticketStatus(
  pool: Pool,
  ticketId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ status: string }>(
    'SELECT status FROM valid_tickets WHERE ticket_id = $1',
    [ticketId],
  );
  return rows[0]?.status;
}

/** Espera os ingressos chegarem à cópia local, no estado informado. */
export function waitForTickets(
  pool: Pool,
  ticketIds: string[],
  status = 'VALID',
): Promise<true> {
  return eventually(async () => {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM valid_tickets
        WHERE ticket_id = ANY($1::uuid[]) AND status = $2`,
      [ticketIds, status],
    );
    return rows[0].count === ticketIds.length;
  }, `${ticketIds.length} ingresso(s) ${status} na cópia local`);
}

/** Espera o show chegar à cópia local, na versão informada. */
export function waitForShow(
  pool: Pool,
  showId: string,
  version = 1,
): Promise<true> {
  return eventually(async () => {
    const { rows } = await pool.query<{ version: number }>(
      'SELECT version FROM shows WHERE show_id = $1',
      [showId],
    );
    return rows[0]?.version === version;
  }, `o show ${showId} v${version} na cópia local`);
}

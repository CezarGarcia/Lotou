import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { setupApp } from '../../src/app.setup.js';
import type { Role } from '../../src/auth/authenticated-user.js';
import { JWT_KEY_SET } from '../../src/auth/token-verifier.js';
import { envSchema } from '../../src/config/env.js';
import { REDIS_CACHE, REDIS_CORE } from '../../src/redis/redis.client.js';
import { createTestIssuer, type TestIssuer } from './auth.js';

export interface TestApp {
  app: INestApplication<App>;
  issuer: TestIssuer;
  /** As conexões da aplicação com o Redis, para conferir e mexer nas chaves. */
  redisCache: Redis;
  redisCore: Redis;
  /** Cliente HTTP sem token. */
  anonymous: ApiClient;
  /** Cliente HTTP de um usuário novo com os papéis informados. */
  as(...roles: Role[]): Promise<ApiClient>;
  close(): Promise<void>;
}

export interface ApiClient {
  get(url: string): request.Test;
  /** POST com uma `Idempotency-Key` nova, a menos que `key` seja informada. */
  post(url: string, body?: object, key?: string | null): request.Test;
  patch(url: string, body: object): request.Test;
}

export interface TestAppOptions {
  /** Variáveis de ambiente só desta aplicação, por cima das do processo. */
  env?: Record<string, string>;
}

/**
 * A aplicação real, com o AppModule inteiro e o MongoDB e o Redis do
 * Testcontainers. A única troca é o conjunto de chaves do emissor de tokens,
 * que é local.
 */
export async function createTestApp({
  env,
}: TestAppOptions = {}): Promise<TestApp> {
  const issuer = await createTestIssuer();
  const builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JWT_KEY_SET)
    .useValue(issuer.keySet);
  if (env) {
    // O ConfigModule lê o ambiente uma vez, ao importar o AppModule; aqui a
    // configuração é refeita com a mesma validação da subida.
    builder
      .overrideProvider(ConfigService)
      .useValue(new ConfigService(envSchema.parse({ ...process.env, ...env })));
  }
  const moduleRef = await builder.compile();
  const app = setupApp(
    moduleRef.createNestApplication<INestApplication<App>>(),
  );
  await app.init();

  const client = (token?: string): ApiClient => {
    const authorize = (test: request.Test) =>
      token ? test.set('Authorization', `Bearer ${token}`) : test;
    const http = () => request(app.getHttpServer());
    return {
      get: (url) => authorize(http().get(url)),
      post: (url, body = {}, key = randomUUID()) => {
        const test = authorize(http().post(url)).send(body);
        return key === null ? test : test.set('Idempotency-Key', key);
      },
      patch: (url, body) => authorize(http().patch(url)).send(body),
    };
  };

  return {
    app,
    issuer,
    redisCache: app.get(REDIS_CACHE),
    redisCore: app.get(REDIS_CORE),
    anonymous: client(),
    as: async (...roles) => client(await issuer.token({ roles })),
    close: () => app.close(),
  };
}

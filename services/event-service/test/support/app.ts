import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { setupApp } from '../../src/app.setup.js';
import type { Role } from '../../src/auth/authenticated-user.js';
import { JWT_KEY_SET } from '../../src/auth/token-verifier.js';
import { createTestIssuer, type TestIssuer } from './auth.js';

export interface TestApp {
  app: INestApplication<App>;
  issuer: TestIssuer;
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

/**
 * A aplicação real, com o AppModule inteiro e o MongoDB do Testcontainers. A
 * única troca é o conjunto de chaves do emissor de tokens, que é local.
 */
export async function createTestApp(): Promise<TestApp> {
  const issuer = await createTestIssuer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(JWT_KEY_SET)
    .useValue(issuer.keySet)
    .compile();
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
    anonymous: client(),
    as: async (...roles) => client(await issuer.token({ roles })),
    close: () => app.close(),
  };
}

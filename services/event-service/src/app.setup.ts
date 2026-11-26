import { type INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Express } from 'express';
import type { Env } from './config/env.js';

/** Configuração da borda HTTP, compartilhada entre o `main.ts` e os testes. */
export function setupApp<T extends INestApplication>(app: T): T {
  // Atrás do nginx e do gateway, o IP do cliente vem no X-Forwarded-For; o
  // rate limit por IP depende dele.
  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const express = app.getHttpAdapter().getInstance() as Express;
  express.set('trust proxy', config.get('TRUST_PROXY', { infer: true }));
  // A versão vai na URL: /v1/shows.
  app.enableVersioning({ type: VersioningType.URI });
  app.useSecurityHeaders();
  app.enableShutdownHooks();
  return app;
}

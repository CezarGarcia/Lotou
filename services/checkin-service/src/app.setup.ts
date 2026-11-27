import { type INestApplication, VersioningType } from '@nestjs/common';

/** Configuração da borda HTTP, compartilhada entre o `main.ts` e os testes. */
export function setupApp<T extends INestApplication>(app: T): T {
  // A versão vai na URL: /v1/checkins.
  app.enableVersioning({ type: VersioningType.URI });
  app.useSecurityHeaders();
  // SIGTERM do Docker: para o consumidor, grava as recusas pendentes, publica
  // o último lote do outbox e fecha as conexões antes de sair.
  app.enableShutdownHooks();
  return app;
}

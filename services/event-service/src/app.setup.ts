import { type INestApplication, VersioningType } from '@nestjs/common';

/** Configuração da borda HTTP, compartilhada entre o `main.ts` e os testes. */
export function setupApp<T extends INestApplication>(app: T): T {
  // A versão vai na URL: /v1/shows.
  app.enableVersioning({ type: VersioningType.URI });
  app.useSecurityHeaders();
  app.enableShutdownHooks();
  return app;
}

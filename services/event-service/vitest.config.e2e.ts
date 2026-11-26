import { defineConfig } from 'vitest/config';

// Testes de integração: a aplicação inteira contra um MongoDB real, que o
// Testcontainers sobe uma vez para a execução toda.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    hookTimeout: 60_000,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Os testes avançam o estado dos shows chamando o serviço, sem o timer.
      SHOW_LIFECYCLE_INTERVAL_MS: '0',
      AUTH_ISSUER: 'http://keycloak.test/realms/lotou',
      // Nunca é chamado: os testes trocam o conjunto de chaves por um local.
      AUTH_JWKS_URI: 'http://keycloak.test/realms/lotou/certs',
      AUTH_AUDIENCE: 'lotou-api',
    },
  },
});

import { defineConfig } from 'vitest/config';

// Testes de integração: a aplicação inteira contra um MongoDB e um Redis
// reais, que o Testcontainers sobe uma vez para a execução toda.
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
      // O rate limit fica ligado em todo teste, mas com um teto que nenhum
      // alcança; rate-limit.e2e-spec.ts testa o limite com um teto baixo.
      RATE_LIMIT_MAX: '1000000',
    },
  },
});

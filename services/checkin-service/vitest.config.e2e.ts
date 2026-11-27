import { defineConfig } from 'vitest/config';

// Testes de integração: a aplicação inteira contra Postgres, Redis e Kafka
// reais, que o Testcontainers sobe uma vez para a execução toda.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    // Os arquivos usam os mesmos tópicos e o mesmo consumer group: um de cada
    // vez, senão duas aplicações dividiriam as partições de order.events.
    fileParallelism: false,
    // O teste de latência escreve o p99 medido na saída, mesmo passando.
    silent: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      TICKET_QR_KEY: 'lotou-test-ticket-qr-key',
      AUTH_ISSUER: 'http://keycloak.test/realms/lotou',
      // Nunca é chamado: os testes trocam o conjunto de chaves por um local.
      AUTH_JWKS_URI: 'http://keycloak.test/realms/lotou/certs',
      AUTH_AUDIENCE: 'lotou-api',
      // Esperas curtas, para os testes andarem.
      CONSUMER_MAX_ATTEMPTS: '3',
      CONSUMER_RETRY_BACKOFF_MS: '10',
      OUTBOX_POLL_INTERVAL_MS: '100',
      REJECTION_FLUSH_INTERVAL_MS: '50',
    },
  },
});

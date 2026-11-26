import { defineConfig } from 'vitest/config';

// Testes de integração: a aplicação inteira contra um Postgres e um Kafka
// reais, que o Testcontainers sobe uma vez para a execução toda.
export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/support/global-setup.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    // Os arquivos usam os mesmos tópicos e o mesmo consumer group: um de cada
    // vez, senão duas aplicações dividiriam as partições de payment.commands.
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      // Sem latência simulada e com esperas curtas, para os testes andarem.
      LATENCY_MIN_MS: '0',
      LATENCY_MAX_MS: '0',
      CONSUMER_MAX_ATTEMPTS: '3',
      CONSUMER_RETRY_BACKOFF_MS: '10',
      OUTBOX_POLL_INTERVAL_MS: '100',
    },
  },
});

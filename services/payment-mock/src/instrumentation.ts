/**
 * OpenTelemetry. Este arquivo é carregado antes da aplicação, pela linha de
 * comando do Node (`node --import`, veja `start:prod` no package.json): a
 * instrumentação precisa existir antes de o Express, o pino e o driver do
 * Postgres serem importados.
 *
 * Exporta traces, métricas e logs por OTLP para o OTel Collector. O destino e
 * o nome do serviço vêm das variáveis padrão `OTEL_*`.
 *
 * O cliente do Kafka (`@confluentinc/kafka-javascript`) não tem
 * auto-instrumentação: os spans de consumidor e de produtor, e a propagação do
 * `traceparent` nos cabeçalhos, são feitos à mão (`CommandProcessor` e
 * `OutboxRelay`).
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { register } from 'node:module';

// A aplicação é ESM: este hook deixa o OpenTelemetry interceptar os `import`
// das bibliotecas instrumentadas.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

process.env.OTEL_SERVICE_NAME ??= 'payment-mock';
process.env.OTEL_TRACES_EXPORTER ??= 'otlp';
process.env.OTEL_METRICS_EXPORTER ??= 'otlp';
process.env.OTEL_LOGS_EXPORTER ??= 'otlp';

export const OTEL_SDK = Symbol.for('lotou.otel.sdk');

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({
      // Um span por leitura de arquivo, DNS ou socket só gera ruído.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      // A única rota HTTP é o health check; nada de span por middleware.
      '@opentelemetry/instrumentation-express': { enabled: false },
      '@opentelemetry/instrumentation-router': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        // O health check roda a cada poucos segundos e não é tráfego real.
        ignoreIncomingRequestHook: (request) =>
          request.url?.startsWith('/health') ?? false,
      },
      '@opentelemetry/instrumentation-pg': {
        // O relay consulta o outbox a cada meio segundo; sem um span pai, essas
        // consultas viram traces soltos. Com pai (o processamento de um
        // comando, o envio de um lote), aparecem normalmente.
        requireParentSpan: true,
      },
    }),
  ],
});

sdk.start();

// A aplicação encerra o SDK no shutdown, para enviar o último lote de spans.
(globalThis as Record<symbol, unknown>)[OTEL_SDK] = sdk;

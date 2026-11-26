/**
 * OpenTelemetry. Este arquivo é carregado antes da aplicação, pela linha de
 * comando do Node (`node --import`, veja `start:prod` no package.json): a instrumentação precisa
 * existir antes de o Express e o driver do MongoDB serem importados.
 *
 * Exporta traces, métricas e logs por OTLP para o OTel Collector. O destino e
 * o nome do serviço vêm das variáveis padrão `OTEL_*`.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { register } from 'node:module';

// A aplicação é ESM: este hook deixa o OpenTelemetry interceptar os `import`
// das bibliotecas instrumentadas.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

process.env.OTEL_SERVICE_NAME ??= 'event-service';
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
      // O Express só dá nome à rota do span HTTP (`GET /v1/shows/:id`); um
      // span por middleware não ajuda a achar gargalo. O driver do MongoDB já
      // registra cada comando, então o span do Mongoose seria repetido.
      '@opentelemetry/instrumentation-express': {
        ignoreLayersType: [
          ExpressLayerType.MIDDLEWARE,
          ExpressLayerType.ROUTER,
          ExpressLayerType.REQUEST_HANDLER,
        ],
      },
      '@opentelemetry/instrumentation-router': { enabled: false },
      '@opentelemetry/instrumentation-mongoose': { enabled: false },
      '@opentelemetry/instrumentation-http': {
        // O health check roda a cada poucos segundos e não é tráfego real.
        ignoreIncomingRequestHook: (request) =>
          request.url?.startsWith('/health') ?? false,
      },
    }),
  ],
});

sdk.start();

// A aplicação encerra o SDK no shutdown, para enviar o último lote de spans.
(globalThis as Record<symbol, unknown>)[OTEL_SDK] = sdk;

import { context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, StackContextManager, TracerProvider } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/** Para onde o navegador envia os spans: o OTel Collector, pelo mesmo domínio da loja. */
const TRACES_URL = '/otlp/v1/traces';

/**
 * Liga o OpenTelemetry no navegador. É aqui que nasce o trace de uma ação do
 * comprador: cada chamada à API ganha um span e leva o cabeçalho `traceparent`,
 * que o gateway e os serviços continuam até o banco.
 *
 * Roda antes do bootstrap do Angular, para medir também o carregamento da página.
 */
export function startTelemetry(): void {
  context.setGlobalContextManager(new StackContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(
    new TracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'lotou-web' }),
      spanProcessors: [
        new BatchSpanProcessor({ exporter: new OTLPTraceExporter({ url: TRACES_URL }) }),
      ],
    }),
  );

  // O envio dos próprios spans não pode gerar spans.
  const ignoreUrls = [/\/otlp\//];
  registerInstrumentations({
    instrumentations: [
      new DocumentLoadInstrumentation(),
      new FetchInstrumentation({ ignoreUrls }),
      new XMLHttpRequestInstrumentation({ ignoreUrls }),
    ],
  });
}

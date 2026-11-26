import { Span, context, propagation, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, StackContextManager, TracerProvider } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_URL_FULL } from '@opentelemetry/semantic-conventions';

/** Para onde o navegador envia os spans: o OTel Collector, pelo mesmo domínio da loja. */
const TRACES_URL = '/otlp/v1/traces';

/** Parâmetros que o Keycloak devolve na volta do login. */
const AUTH_PARAMS = ['code', 'state', 'session_state', 'iss'];

/**
 * Tira da URL o código de autorização e o state do login. A página pode
 * terminar de carregar ainda com `?code=...` na barra, e o span do carregamento
 * guarda a URL.
 */
export function redactAuthParams(href: string): string {
  try {
    const url = new URL(href);
    let changed = false;
    for (const name of AUTH_PARAMS) {
      if (url.searchParams.has(name)) {
        url.searchParams.set(name, 'REDACTED');
        changed = true;
      }
    }
    return changed ? url.toString() : href;
  } catch {
    return href;
  }
}

const redactPageUrl = (span: Span) =>
  span.setAttribute(ATTR_URL_FULL, redactAuthParams(globalThis.location.href));

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
      new DocumentLoadInstrumentation({
        applyCustomAttributesOnSpan: { documentLoad: redactPageUrl, documentFetch: redactPageUrl },
      }),
      new FetchInstrumentation({ ignoreUrls }),
      new XMLHttpRequestInstrumentation({ ignoreUrls }),
    ],
  });
}

import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  type TextMapGetter,
} from '@opentelemetry/api';

/** Cabeçalhos do W3C Trace Context que atravessam o broker. */
export type TraceHeaders = { traceparent?: string; tracestate?: string };

const TRACE_KEYS = ['traceparent', 'tracestate'] as const;

/** Um cabeçalho do Kafka como texto (o consumidor recebe `Buffer`). */
export function headerText(
  headers: KafkaJS.IHeaders | undefined,
  key: string,
): string | undefined {
  const value = headers?.[key];
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined ? undefined : first.toString();
}

const kafkaHeaderGetter: TextMapGetter<KafkaJS.IHeaders> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => headerText(carrier, key),
};

/** O contexto de trace que veio na mensagem, para o span do consumidor. */
export function extractContext(headers: KafkaJS.IHeaders | undefined): Context {
  return propagation.extract(ROOT_CONTEXT, headers ?? {}, kafkaHeaderGetter);
}

/** Só os cabeçalhos de trace de uma mensagem recebida. */
export function traceHeadersOf(
  headers: KafkaJS.IHeaders | undefined,
): TraceHeaders {
  const result: TraceHeaders = {};
  for (const key of TRACE_KEYS) {
    const value = headerText(headers, key);
    if (value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Os cabeçalhos de trace do contexto informado (por padrão, o ativo). Sem o
 * SDK do OpenTelemetry (testes, por exemplo), a propagação não escreve nada, e
 * vale o `fallback`: os cabeçalhos que chegaram com o comando, para o trace
 * seguir mesmo assim.
 */
export function traceHeadersFrom(
  fallback: TraceHeaders = {},
  from: Context = context.active(),
): TraceHeaders {
  const carrier: Record<string, string> = {};
  propagation.inject(from, carrier);
  if (!carrier.traceparent) {
    return { ...fallback };
  }
  const result: TraceHeaders = { traceparent: carrier.traceparent };
  if (carrier.tracestate) {
    result.tracestate = carrier.tracestate;
  }
  return result;
}

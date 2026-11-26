import {
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';

/** Tracer dos spans criados à mão (Kafka, job de abertura das vendas). */
export const tracer = trace.getTracer('lotou.event');

/**
 * O contexto do trace em cabeçalhos W3C (`traceparent` e, se houver,
 * `tracestate`). Vazio quando não há trace ativo ou sem o SDK (testes).
 */
export function traceHeaders(
  from: Context = context.active(),
): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(from, carrier);
  return carrier;
}

/**
 * O contexto de trace que veio em cabeçalhos W3C. Parte da raiz, e não do
 * contexto ativo: o span de quem processa a mensagem continua o trace de
 * quem a gerou, não o do laço que a leu.
 */
export function contextFrom(headers: Record<string, string>): Context {
  return propagation.extract(ROOT_CONTEXT, headers);
}

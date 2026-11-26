import {
  propagation,
  ROOT_CONTEXT,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { contextFrom, traceHeaders } from './trace-context.js';

describe('contexto de trace em cabeçalhos', () => {
  beforeAll(() => {
    // O SDK registra este propagador em produção (instrumentation.ts).
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  });
  afterAll(() => propagation.disable());

  const spanContext = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    spanId: '00f067aa0ba902b7',
    traceFlags: TraceFlags.SAMPLED,
  };

  it('grava o trace ativo como traceparent', () => {
    const active = trace.setSpanContext(ROOT_CONTEXT, spanContext);
    expect(traceHeaders(active)).toEqual({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
  });

  it('sem trace ativo, não grava nada', () => {
    expect(traceHeaders(ROOT_CONTEXT)).toEqual({});
  });

  it('lê de volta o mesmo trace', () => {
    const headers = traceHeaders(
      trace.setSpanContext(ROOT_CONTEXT, spanContext),
    );
    expect(trace.getSpanContext(contextFrom(headers))).toMatchObject({
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      isRemote: true,
    });
  });
});

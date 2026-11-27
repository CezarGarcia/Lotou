import { propagation, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  extractContext,
  headerText,
  traceHeadersFrom,
  traceHeadersOf,
} from './trace-headers.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const TRACEPARENT = `00-${TRACE_ID}-b7ad6b7169203331-01`;

describe('cabeçalhos de trace', () => {
  afterEach(() => propagation.disable());

  it('lê o cabeçalho que chega como Buffer ou lista', () => {
    expect(headerText({ a: Buffer.from('x') }, 'a')).toBe('x');
    expect(headerText({ a: [Buffer.from('y'), 'z'] }, 'a')).toBe('y');
    expect(headerText({}, 'a')).toBeUndefined();
    expect(headerText(undefined, 'a')).toBeUndefined();
  });

  it('separa só traceparent e tracestate', () => {
    expect(
      traceHeadersOf({
        traceparent: Buffer.from(TRACEPARENT),
        tracestate: Buffer.from('lotou=1'),
        outro: Buffer.from('x'),
      }),
    ).toEqual({ traceparent: TRACEPARENT, tracestate: 'lotou=1' });
  });

  describe('com o propagador W3C (SDK ligado)', () => {
    beforeEach(() =>
      propagation.setGlobalPropagator(new W3CTraceContextPropagator()),
    );

    it('continua o trace que veio na mensagem', () => {
      const context = extractContext({ traceparent: Buffer.from(TRACEPARENT) });
      expect(trace.getSpanContext(context)?.traceId).toBe(TRACE_ID);
    });

    it('escreve o traceparent do contexto informado, não o de reserva', () => {
      const context = extractContext({ traceparent: Buffer.from(TRACEPARENT) });
      expect(
        traceHeadersFrom({ traceparent: 'reserva' }, context).traceparent,
      ).toBe(TRACEPARENT);
    });
  });

  it('sem SDK, mantém os cabeçalhos recebidos para o trace seguir', () => {
    expect(
      traceHeadersFrom({ traceparent: TRACEPARENT }, ROOT_CONTEXT),
    ).toEqual({ traceparent: TRACEPARENT });
  });
});

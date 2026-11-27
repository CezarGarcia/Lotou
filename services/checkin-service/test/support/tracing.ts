import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

/**
 * Um SDK de traces mínimo, só em memória, no lugar do `instrumentation.ts`:
 * com ele, os spans de consumidor e de produtor existem de verdade e os testes
 * conferem que o trace atravessa o Kafka.
 */
export const spans = new InMemorySpanExporter();

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());
trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
  }),
);

import { SpanKind } from '@opentelemetry/api';
import request from 'supertest';
import { TOPICS } from '../src/kafka/topics.js';
import { createTestApp, paymentsOf, type TestApp } from './support/app.js';
import { contractErrors } from './support/contracts.js';
import {
  authorizeCommand,
  newTraceparent,
  spanIdOf,
  traceIdOf,
} from './support/fixtures.js';
import { CommandSender, settle, TopicRecorder } from './support/kafka.js';
import { spans } from './support/tracing.js';

describe('AuthorizePayment', () => {
  let t: TestApp;
  let sender: CommandSender;
  let recorder: TopicRecorder;

  beforeAll(async () => {
    [t, sender, recorder] = await Promise.all([
      createTestApp(),
      CommandSender.start(),
      TopicRecorder.start(),
    ]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    t.draws.approve();
  });
  afterAll(async () => {
    await Promise.all([t?.close(), sender?.stop(), recorder?.stop()]);
  });

  it('aprova, grava e responde PaymentAuthorized no contrato, com a chave do pedido', async () => {
    const metrics = vi.spyOn(t.metrics, 'record');
    const command = authorizeCommand();
    const { orderId, amountCents } = command.payload;

    await sender.send(command);
    const [answer] = await recorder.waitForAnswers(orderId);

    expect(contractErrors(TOPICS.events, answer.value)).toEqual([]);
    expect(answer.key).toBe(orderId);
    expect(answer.value).toMatchObject({
      type: 'PaymentAuthorized',
      version: 1,
      payload: { orderId, amountCents },
    });

    const [payment] = await paymentsOf(t.pool, orderId);
    expect(payment).toMatchObject({
      id: answer.value.payload.paymentId,
      status: 'AUTHORIZED',
      amount_cents: String(amountCents),
      buyer_id: command.payload.buyerId,
    });
    expect(payment.decided_at.toISOString()).toBe(
      answer.value.payload.authorizedAt,
    );
    const processed = await t.pool.query(
      'SELECT type FROM processed_events WHERE event_id = $1',
      [command.eventId],
    );
    expect(processed.rows).toEqual([{ type: 'AuthorizePayment' }]);
    const outbox = await t.pool.query(
      'SELECT published_at FROM outbox WHERE id = $1',
      [answer.value.eventId],
    );
    expect(outbox.rows[0].published_at).toBeInstanceOf(Date);
    expect(metrics).toHaveBeenCalledWith('authorized');
  });

  it('recusa com o motivo do contrato e responde PaymentDeclined', async () => {
    const metrics = vi.spyOn(t.metrics, 'record');
    t.draws.decline();
    const command = authorizeCommand();
    const { orderId } = command.payload;

    await sender.send(command);
    const [answer] = await recorder.waitForAnswers(orderId);

    expect(contractErrors(TOPICS.events, answer.value)).toEqual([]);
    expect(answer.value).toMatchObject({
      type: 'PaymentDeclined',
      payload: { orderId, reason: 'INSUFFICIENT_FUNDS' },
    });
    const [payment] = await paymentsOf(t.pool, orderId);
    expect(payment).toMatchObject({
      status: 'DECLINED',
      decline_reason: 'INSUFFICIENT_FUNDS',
    });
    expect(metrics).toHaveBeenCalledWith('declined');
  });

  it('a mesma mensagem entregue duas vezes tem uma resposta só', async () => {
    const command = authorizeCommand();
    const { orderId } = command.payload;

    await sender.send(command);
    await sender.send(command);
    await recorder.waitForAnswers(orderId);
    await settle();

    expect(recorder.answers(orderId)).toHaveLength(1);
    expect(await paymentsOf(t.pool, orderId)).toHaveLength(1);
  });

  it('um segundo AuthorizePayment do pedido recebe a mesma resposta, sem cobrar de novo', async () => {
    const metrics = vi.spyOn(t.metrics, 'record');
    const first = authorizeCommand();
    const { orderId } = first.payload;
    await sender.send(first);
    const [original] = await recorder.waitForAnswers(orderId);

    // Agora o gateway recusaria; não pode ser consultado de novo.
    t.draws.decline();
    await sender.send(authorizeCommand(orderId, { amountCents: 1 }));
    const [, repeated] = await recorder.waitForAnswers(orderId, 2);

    expect(contractErrors(TOPICS.events, repeated.value)).toEqual([]);
    expect(repeated.value.eventId).not.toBe(original.value.eventId);
    expect(repeated.value.type).toBe('PaymentAuthorized');
    expect(repeated.value.payload).toEqual(original.value.payload);
    expect(await paymentsOf(t.pool, orderId)).toHaveLength(1);
    expect(metrics.mock.calls).toEqual([['authorized']]);
  });

  it('continua o trace do comando: consumidor, banco e produtor no mesmo trace', async () => {
    spans.reset();
    const command = authorizeCommand();
    const { orderId } = command.payload;
    const incoming = newTraceparent();

    await sender.send(command, { traceparent: incoming.traceparent });
    const [answer] = await recorder.waitForAnswers(orderId);

    const outgoing = answer.headers.traceparent;
    expect(traceIdOf(outgoing)).toBe(incoming.traceId);

    // O span do consumidor termina depois que a resposta já pode ter saído.
    const inTrace = await vi.waitFor(() => {
      const found = spans
        .getFinishedSpans()
        .filter((span) => span.spanContext().traceId === incoming.traceId);
      const kinds = found.map((span) => span.kind);
      expect(kinds).toContain(SpanKind.CONSUMER);
      expect(kinds).toContain(SpanKind.PRODUCER);
      return found;
    });
    const consumer = inTrace.find((span) => span.kind === SpanKind.CONSUMER);
    const producer = inTrace.find((span) => span.kind === SpanKind.PRODUCER);
    expect(consumer).toMatchObject({ name: 'process payment.commands' });
    expect(consumer!.parentSpanContext?.spanId).toBe(incoming.spanId);
    expect(consumer!.attributes).toMatchObject({
      'messaging.message.id': command.eventId,
      'lotou.order.id': orderId,
    });
    expect(producer).toMatchObject({ name: 'send payment.events' });
    expect(producer!.parentSpanContext?.spanId).toBe(
      consumer!.spanContext().spanId,
    );
    // O order-service recebe o span do produtor como pai.
    expect(spanIdOf(outgoing)).toBe(producer!.spanContext().spanId);
  });
});

describe('Health check', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t?.close());

  it('fica pronto com o Postgres e o Kafka respondendo', async () => {
    const server = t.app.getHttpServer();
    await request(server).get('/health/live').expect(200);
    const ready = await request(server).get('/health/ready').expect(200);
    expect(ready.body).toMatchObject({
      status: 'ok',
      info: { postgres: { status: 'up' }, kafka: { status: 'up' } },
    });
  });
});

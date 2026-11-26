import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { ConfigService } from '@nestjs/config';
import { newId } from '../src/common/ids.js';
import { type Env, envSchema } from '../src/config/env.js';
import { withTransaction } from '../src/database/transaction.js';
import { KAFKA_PRODUCER } from '../src/kafka/kafka.module.js';
import { TOPICS } from '../src/kafka/topics.js';
import { paymentRefunded } from '../src/messages/events.js';
import { enqueue } from '../src/outbox/outbox.repository.js';
import { OutboxRelay } from '../src/outbox/outbox.relay.js';
import { createTestApp, type TestApp } from './support/app.js';
import { newTraceparent, traceIdOf } from './support/fixtures.js';
import { settle, TopicRecorder } from './support/kafka.js';

describe('Relay do outbox', () => {
  let t: TestApp;
  let recorder: TopicRecorder;
  let producer: KafkaJS.Producer;

  beforeAll(async () => {
    [t, recorder] = await Promise.all([createTestApp(), TopicRecorder.start()]);
    producer = t.app.get(KAFKA_PRODUCER);
    // Os testes controlam quando e quantos relays publicam.
    await t.relay.stop();
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all([t?.close(), recorder?.stop()]);
  });

  /** Grava `perKey` respostas para cada pedido, intercaladas, e devolve os eventIds por pedido. */
  async function fill(keys: string[], perKey: number, headers = {}) {
    const expected = new Map<string, string[]>(keys.map((k) => [k, []]));
    await withTransaction(t.pool, async (client) => {
      for (let i = 0; i < perKey; i++) {
        for (const orderId of keys) {
          const event = paymentRefunded(
            { orderId, paymentId: newId(), amountCents: i },
            new Date(),
          );
          await enqueue(client, {
            topic: TOPICS.events,
            key: orderId,
            event,
            headers,
          });
          expected.get(orderId)!.push(event.eventId);
        }
      }
    });
    return expected;
  }

  async function pending(keys: string[]): Promise<number> {
    const { rows } = await t.pool.query(
      `SELECT count(*)::int AS n FROM outbox
        WHERE published_at IS NULL AND message_key = ANY($1)`,
      [keys],
    );
    return rows[0].n;
  }

  function relay(batchSize: number): OutboxRelay {
    const config = new ConfigService<Env, true>(
      envSchema.parse({ ...process.env, OUTBOX_BATCH_SIZE: String(batchSize) }),
    );
    return new OutboxRelay(t.pool, producer, config);
  }

  it('três instâncias publicam tudo uma vez só, na ordem de cada pedido', async () => {
    const keys = Array.from({ length: 12 }, () => newId());
    const expected = await fill(keys, 5);

    const relays = [relay(7), relay(7), relay(7)];
    await Promise.all(
      relays.map(async (r) => {
        while ((await pending(keys)) > 0) {
          await r.publishPending();
        }
      }),
    );

    for (const orderId of keys) {
      const received = await recorder.waitForAnswers(orderId, 5);
      expect(received.map((m) => m.value.eventId)).toEqual(
        expected.get(orderId),
      );
    }
    await settle(500);
    for (const orderId of keys) {
      expect(recorder.answers(orderId)).toHaveLength(5);
    }
  });

  it('com o broker falhando, as mensagens ficam no outbox e saem na tentativa seguinte', async () => {
    const [orderId] = [newId()];
    const expected = await fill([orderId], 2);
    vi.spyOn(producer, 'sendBatch').mockRejectedValueOnce(
      new Error('broker indisponível'),
    );

    await expect(t.relay.publishPending()).rejects.toThrow(
      'broker indisponível',
    );
    expect(await pending([orderId])).toBe(2);

    while ((await pending([orderId])) > 0) {
      await t.relay.publishPending();
    }
    const received = await recorder.waitForAnswers(orderId, 2);
    expect(received.map((m) => m.value.eventId)).toEqual(expected.get(orderId));
  });

  it('ao subir, publica o que ficou pendente e leva o trace guardado na linha', async () => {
    const orderId = newId();
    const incoming = newTraceparent();
    const expected = await fill([orderId], 1, {
      traceparent: incoming.traceparent,
    });

    t.relay.start();
    const [message] = await recorder.waitForAnswers(orderId);
    await t.relay.stop();

    expect(message.value.eventId).toBe(expected.get(orderId)![0]);
    expect(traceIdOf(message.headers.traceparent)).toBe(incoming.traceId);
    expect(await pending([orderId])).toBe(0);
  });
});

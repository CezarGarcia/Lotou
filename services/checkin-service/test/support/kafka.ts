import { KafkaJS } from '@confluentinc/kafka-javascript';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { inject } from 'vitest';
import { CONSUMED_TOPICS, dltOf, TOPICS } from '../../src/kafka/topics.js';

const kafka = () =>
  new KafkaJS.Kafka({
    kafkaJS: {
      brokers: [inject('kafkaBrokers')],
      logLevel: KafkaJS.logLevel.NOTHING,
    },
  });

export interface Received {
  topic: string;
  key: string | null;
  /** O valor como JSON; `undefined` se não for JSON. */
  value: any;
  headers: Record<string, string>;
}

/**
 * Lê `checkin.events` e as DLTs desde o começo, num grupo só dele, e guarda
 * tudo. Os testes filtram pela chave (o show), que é única por teste.
 */
export class TopicRecorder {
  readonly messages: Received[] = [];

  private constructor(private readonly consumer: KafkaJS.Consumer) {}

  static async start(
    topics: string[] = [TOPICS.checkinEvents, ...CONSUMED_TOPICS.map(dltOf)],
  ): Promise<TopicRecorder> {
    const consumer = kafka().consumer({
      kafkaJS: {
        groupId: `test-recorder-${randomUUID()}`,
        fromBeginning: true,
        autoCommit: false,
      },
    });
    const recorder = new TopicRecorder(consumer);
    await consumer.connect();
    await consumer.subscribe({ topics });
    await consumer.run({
      eachMessage: async ({ topic, message }) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(message.headers ?? {})) {
          const first = Array.isArray(value) ? value[0] : value;
          if (first !== undefined) {
            headers[key] = first.toString();
          }
        }
        let value: unknown;
        try {
          value = message.value && JSON.parse(message.value.toString());
        } catch {
          value = undefined;
        }
        recorder.messages.push({
          topic,
          key: message.key?.toString() ?? null,
          value,
          headers,
        });
      },
    });
    return recorder;
  }

  /** As mensagens de um tópico com a chave informada, na ordem de chegada. */
  of(topic: string, key: string): Received[] {
    return this.messages.filter((m) => m.topic === topic && m.key === key);
  }

  /** Os eventos do show em `checkin.events`. */
  eventsOf(showId: string): Received[] {
    return this.of(TOPICS.checkinEvents, showId);
  }

  /** Espera até haver `count` mensagens do tópico com a chave, e as devolve. */
  async waitFor(
    topic: string,
    key: string,
    count = 1,
    timeoutMs = 25_000,
  ): Promise<Received[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.of(topic, key);
      if (found.length >= count) {
        return found;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Esperava ${count} mensagem(ns) em ${topic} com a chave ${key}; chegaram ${found.length}`,
        );
      }
      await sleep(50);
    }
  }

  waitForEvents(showId: string, count = 1): Promise<Received[]> {
    return this.waitFor(TOPICS.checkinEvents, showId, count);
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}

/** Publica em `order.events` e `shows.catalog`, como o order-service e o event-service. */
export class EventSender {
  private constructor(private readonly producer: KafkaJS.Producer) {}

  static async start(): Promise<EventSender> {
    const producer = kafka().producer({ kafkaJS: { idempotent: true } });
    await producer.connect();
    return new EventSender(producer);
  }

  /** `TicketsIssued`, `TicketsCancelled` e outros fatos do pedido; chave `orderId`. */
  order(event: { payload: { orderId: string } }): Promise<void> {
    return this.send(TOPICS.orderEvents, event.payload.orderId, event);
  }

  /** `ShowPublished` e `ShowUpdated`; chave `showId`. */
  catalog(event: { payload: { showId: string } }): Promise<void> {
    return this.send(TOPICS.catalog, event.payload.showId, event);
  }

  /** Envia o valor como veio (`string` vai como bytes, sem JSON). */
  async send(topic: string, key: string, value: unknown): Promise<void> {
    await this.producer.send({
      topic,
      messages: [
        {
          key,
          value: typeof value === 'string' ? value : JSON.stringify(value),
        },
      ],
    });
  }

  async stop(): Promise<void> {
    await this.producer.disconnect();
  }
}

/** Espera um pouco e confere que nada mais chegou (para "não publicou de novo"). */
export async function settle(ms = 1_500): Promise<void> {
  await sleep(ms);
}

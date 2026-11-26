import { KafkaJS } from '@confluentinc/kafka-javascript';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { inject } from 'vitest';
import { TOPICS } from '../../src/kafka/topics.js';

const kafka = () =>
  new KafkaJS.Kafka({
    kafkaJS: {
      brokers: [inject('kafkaBrokers')],
      logLevel: KafkaJS.logLevel.NOTHING,
    },
  });

export interface Received {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  /** O valor como JSON; `undefined` se não for JSON. */
  value: any;
  raw: Buffer | null;
  headers: Record<string, string>;
}

/**
 * Lê `payment.events` e `payment.commands.dlt` desde o começo, num grupo só
 * dele, e guarda tudo. Os testes filtram pela chave (o pedido), que é única
 * por teste.
 */
export class TopicRecorder {
  readonly messages: Received[] = [];

  private constructor(private readonly consumer: KafkaJS.Consumer) {}

  static async start(
    topics: string[] = [TOPICS.events, TOPICS.commandsDlt],
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
      eachMessage: async ({ topic, partition, message }) => {
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
          partition,
          offset: message.offset,
          key: message.key?.toString() ?? null,
          value,
          raw: message.value,
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

  /** As respostas publicadas para o pedido. */
  answers(orderId: string): Received[] {
    return this.of(TOPICS.events, orderId);
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

  waitForAnswers(orderId: string, count = 1): Promise<Received[]> {
    return this.waitFor(TOPICS.events, orderId, count);
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}

/** Publica em `payment.commands` como o order-service. */
export class CommandSender {
  private constructor(private readonly producer: KafkaJS.Producer) {}

  static async start(): Promise<CommandSender> {
    const producer = kafka().producer({ kafkaJS: { idempotent: true } });
    await producer.connect();
    return new CommandSender(producer);
  }

  /** Envia o envelope com a chave do pedido; `raw` envia bytes quaisquer. */
  async send(
    command: { payload: { orderId: string } } | { raw: string; key: string },
    headers: Record<string, string> = {},
  ): Promise<void> {
    const [key, value] =
      'raw' in command
        ? [command.key, command.raw]
        : [command.payload.orderId, JSON.stringify(command)];
    await this.producer.send({
      topic: TOPICS.commands,
      messages: [{ key, value, headers }],
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

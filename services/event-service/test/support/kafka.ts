import { KafkaJS } from '@confluentinc/kafka-javascript';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import { headersAsText } from '../../src/kafka/kafka.js';

const EXTERNAL_PORT = 9094;
const STARTER = '/tmp/start-kafka.sh';
const WAITING = 'Esperando o script de subida';

/**
 * Kafka 4.2 em KRaft, um broker só, com a mesma configuração do Compose. O
 * endereço anunciado precisa da porta que o Docker escolheu no host, que só
 * se conhece depois de o container subir: o container espera um script, que
 * é copiado com a porta e então inicia o broker.
 */
export async function startKafka(): Promise<{
  container: StartedTestContainer;
  brokers: string;
}> {
  const container = await new GenericContainer('apache/kafka:4.2.0')
    .withExposedPorts(EXTERNAL_PORT)
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: `INTERNAL://:9092,EXTERNAL://:${EXTERNAL_PORT},CONTROLLER://:9093`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'INTERNAL:PLAINTEXT,EXTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_OFFSETS_TOPIC_NUM_PARTITIONS: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_TRANSACTION_STATE_LOG_NUM_PARTITIONS: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
    })
    .withEntrypoint(['sh'])
    .withCommand([
      '-c',
      `echo '${WAITING}'; while [ ! -f ${STARTER} ]; do sleep 0.1; done; . ${STARTER}`,
    ])
    .withWaitStrategy(Wait.forLogMessage(WAITING))
    .start();

  const brokers = `${container.getHost()}:${container.getMappedPort(EXTERNAL_PORT)}`;
  await container.copyContentToContainer([
    {
      content: [
        `export KAFKA_ADVERTISED_LISTENERS=INTERNAL://localhost:9092,EXTERNAL://${brokers}`,
        'exec /__cacert_entrypoint.sh /etc/kafka/docker/run',
      ].join('\n'),
      target: STARTER,
      mode: 0o755,
    },
  ]);
  await createTopics(brokers);
  return { container, brokers };
}

/** Os tópicos que o event-service usa, como em infra/kafka/create-topics.sh. */
async function createTopics(brokers: string): Promise<void> {
  const admin = kafka(brokers).admin();
  await retry(() => admin.connect());
  try {
    await retry(() =>
      admin.createTopics({
        topics: [
          {
            topic: 'shows.catalog',
            numPartitions: 3,
            configEntries: [{ name: 'cleanup.policy', value: 'compact' }],
          },
          { topic: 'inventory.events', numPartitions: 3 },
          { topic: 'inventory.events.dlt', numPartitions: 3 },
        ],
      }),
    );
  } finally {
    await admin.disconnect();
  }
}

async function retry<T>(action: () => Promise<T>, attempts = 60): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= attempts) {
        throw error;
      }
      await sleep(500);
    }
  }
}

export const kafka = (brokers = process.env.KAFKA_BROKERS!) =>
  new KafkaJS.Kafka({
    kafkaJS: { brokers: brokers.split(','), logLevel: KafkaJS.logLevel.ERROR },
  });

export interface ReadMessage {
  key: string;
  value: Record<string, unknown> & { payload: Record<string, unknown> };
  headers: Record<string, string>;
  partition: number;
  offset: string;
}

/**
 * Lê um tópico do começo, num grupo só deste leitor, e guarda as mensagens.
 * Por padrão só lê o que foi confirmado (read_committed), como os
 * consumidores do Lotou; `readUncommitted` mostra também o que ficou em
 * transações abortadas.
 */
export class TopicReader {
  readonly messages: ReadMessage[] = [];
  private readonly consumer: KafkaJS.Consumer;

  private constructor(
    readonly topic: string,
    readUncommitted: boolean,
  ) {
    this.consumer = kafka().consumer({
      kafkaJS: {
        groupId: `test-${randomUUID()}`,
        fromBeginning: true,
        readUncommitted,
      },
    });
  }

  static async start(
    topic: string,
    { readUncommitted = false } = {},
  ): Promise<TopicReader> {
    const reader = new TopicReader(topic, readUncommitted);
    await reader.consumer.connect();
    await reader.consumer.subscribe({ topics: [topic] });
    await reader.consumer.run({
      eachMessage: async ({ partition, message }) => {
        reader.messages.push({
          key: message.key?.toString() ?? '',
          value: JSON.parse(message.value?.toString() ?? 'null'),
          headers: headersAsText(message.headers),
          partition,
          offset: message.offset,
        });
      },
    });
    return reader;
  }

  /** As mensagens de uma chave, na ordem em que estão no tópico. */
  of(key: string): ReadMessage[] {
    return this.messages.filter((message) => message.key === key);
  }

  /** Espera até a chave ter `count` mensagens (ou mais). */
  async waitFor(
    key: string,
    count: number,
    timeoutMs = 15_000,
  ): Promise<ReadMessage[]> {
    const deadline = Date.now() + timeoutMs;
    while (this.of(key).length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `${this.topic}: esperava ${count} mensagens de ${key}, chegaram ${this.of(key).length}`,
        );
      }
      await sleep(50);
    }
    return this.of(key);
  }

  stop(): Promise<void> {
    return this.consumer.disconnect();
  }
}

/** Publica mensagens como outro serviço faria (o inventory, por exemplo). */
export async function produce(
  topic: string,
  messages: { key: string; value: unknown; headers?: Record<string, string> }[],
): Promise<void> {
  const producer = kafka().producer({
    kafkaJS: { idempotent: true, acks: -1 },
  });
  await producer.connect();
  try {
    await producer.send({
      topic,
      messages: messages.map(({ key, value, headers }) => ({
        key,
        value: typeof value === 'string' ? value : JSON.stringify(value),
        headers,
      })),
    });
  } finally {
    await producer.disconnect();
  }
}

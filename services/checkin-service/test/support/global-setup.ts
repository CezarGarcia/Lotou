import { KafkaJS } from '@confluentinc/kafka-javascript';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { createServer } from 'node:net';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { CONSUMED_TOPICS, dltOf, TOPICS } from '../../src/kafka/topics.js';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
    redisUrl: string;
    kafkaBrokers: string;
  }
}

/** Uma porta livre no host, para o Kafka anunciar o mesmo endereço que expõe. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Kafka 4 em modo KRaft, a mesma imagem do Compose. O módulo do Testcontainers
 * para Kafka só conhece as imagens da Confluent; aqui a porta do container é a
 * mesma do host, para o endereço anunciado aos clientes funcionar de fora.
 */
async function startKafka() {
  const port = await freePort();
  return new GenericContainer('apache/kafka:4.2.0')
    .withExposedPorts({ container: port, host: port })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: `PLAINTEXT://:${port},CONTROLLER://:9093`,
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${port}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      // Como no Compose: tópico só existe se for criado.
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start()
    .then((container) => ({ container, brokers: `localhost:${port}` }));
}

/** Cria os tópicos como o `kafka-init` do Compose, com 3 partições. */
async function createTopics(brokers: string): Promise<void> {
  const admin = new KafkaJS.Kafka({
    kafkaJS: { brokers: [brokers], logLevel: KafkaJS.logLevel.ERROR },
  }).admin();
  await admin.connect();
  try {
    await admin.createTopics({
      topics: [...Object.values(TOPICS), ...CONSUMED_TOPICS.map(dltOf)].map(
        (topic) => ({ topic, numPartitions: 3, replicationFactor: 1 }),
      ),
    });
  } finally {
    await admin.disconnect();
  }
}

/**
 * Sobe um Postgres, um Redis e um Kafka reais, uma vez para a execução toda,
 * e os derruba no fim.
 */
export default async function setup(project: TestProject) {
  const [postgres, redis, kafka] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine').start(),
    // Cada arquivo de teste usa um banco lógico só dele (veja setup-env.ts).
    new RedisContainer('redis:8.8-alpine')
      .withCommand(['redis-server', '--databases', '64'])
      .start(),
    startKafka(),
  ]);
  await createTopics(kafka.brokers);

  project.provide('postgresUrl', postgres.getConnectionUri());
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('kafkaBrokers', kafka.brokers);

  return async () => {
    await Promise.all([postgres.stop(), redis.stop(), kafka.container.stop()]);
  };
}

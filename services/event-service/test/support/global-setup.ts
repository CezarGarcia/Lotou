import { MongoDBContainer } from '@testcontainers/mongodb';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';
import { startKafka } from './kafka.js';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    redisUrl: string;
    kafkaBrokers: string;
  }
}

/**
 * Sobe um MongoDB (replica set, como no Compose), um Redis e um Kafka reais em
 * containers, uma vez, e os derruba no fim.
 */
export default async function setup(project: TestProject) {
  const [mongo, redis, kafka] = await Promise.all([
    new MongoDBContainer('mongo:8.0').start(),
    // Cada arquivo de teste usa dois bancos lógicos só dele (veja setup-env.ts).
    new RedisContainer('redis:8.8-alpine')
      .withCommand(['redis-server', '--databases', '64'])
      .start(),
    startKafka(),
  ]);
  project.provide('mongoUri', mongo.getConnectionString());
  project.provide('redisUrl', redis.getConnectionUrl());
  project.provide('kafkaBrokers', kafka.brokers);

  return async () => {
    await Promise.all([mongo.stop(), redis.stop(), kafka.container.stop()]);
  };
}

import { MongoDBContainer } from '@testcontainers/mongodb';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    redisUrl: string;
  }
}

/** Sobe um MongoDB e um Redis reais em containers, uma vez, e os derruba no fim. */
export default async function setup(project: TestProject) {
  const [mongo, redis] = await Promise.all([
    new MongoDBContainer('mongo:8.0').start(),
    // Cada arquivo de teste usa dois bancos lógicos só dele (veja setup-env.ts).
    new RedisContainer('redis:8.8-alpine')
      .withCommand(['redis-server', '--databases', '64'])
      .start(),
  ]);
  project.provide('mongoUri', mongo.getConnectionString());
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([mongo.stop(), redis.stop()]);
  };
}

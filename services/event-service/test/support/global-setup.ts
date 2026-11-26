import { MongoDBContainer } from '@testcontainers/mongodb';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}

/** Sobe um MongoDB real num container, uma vez, e o derruba no fim. */
export default async function setup(project: TestProject) {
  const container = await new MongoDBContainer('mongo:8.0').start();
  project.provide('mongoUri', container.getConnectionString());

  return async () => {
    await container.stop();
  };
}

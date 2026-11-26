import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { createKafka } from './kafka.js';

/** Token de injeção do cliente do Kafka. */
export const KAFKA = Symbol('KAFKA');

/**
 * O cliente do Kafka, compartilhado pelo relay do outbox e pelo consumidor de
 * `inventory.events`. Cada um cria e fecha o próprio produtor ou consumidor.
 */
@Global()
@Module({
  providers: [
    {
      provide: KAFKA,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createKafka(config.get('KAFKA_BROKERS', { infer: true })),
    },
  ],
  exports: [KAFKA],
})
export class KafkaModule {}

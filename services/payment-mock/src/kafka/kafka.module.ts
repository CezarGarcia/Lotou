import { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { createKafka, createProducer } from './kafka.client.js';

/** Tokens de injeção do cliente, do produtor e do admin do Kafka. */
export const KAFKA = Symbol('KAFKA');
export const KAFKA_PRODUCER = Symbol('KAFKA_PRODUCER');
export const KAFKA_ADMIN = Symbol('KAFKA_ADMIN');

@Injectable()
class KafkaShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(KAFKA_PRODUCER) private readonly producer: KafkaJS.Producer,
    @Inject(KAFKA_ADMIN) private readonly admin: KafkaJS.Admin,
  ) {}

  /**
   * Depois do consumidor e do relay, que param antes
   * (beforeApplicationShutdown): o que eles ainda enviaram sai antes de fechar.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.producer.flush({ timeout: 5_000 }).catch(() => undefined);
    await Promise.allSettled([
      this.producer.disconnect(),
      this.admin.disconnect(),
    ]);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: KAFKA,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createKafka(config.get('KAFKA_BROKERS', { infer: true })),
    },
    {
      provide: KAFKA_PRODUCER,
      inject: [KAFKA],
      useFactory: async (kafka: KafkaJS.Kafka) => {
        const producer = createProducer(kafka);
        await producer.connect();
        return producer;
      },
    },
    {
      // Usado pelo health check, para saber se o broker responde.
      provide: KAFKA_ADMIN,
      inject: [KAFKA],
      useFactory: async (kafka: KafkaJS.Kafka) => {
        const admin = kafka.admin();
        await admin.connect();
        return admin;
      },
    },
    KafkaShutdown,
  ],
  exports: [KAFKA, KAFKA_PRODUCER, KAFKA_ADMIN],
})
export class KafkaModule {}

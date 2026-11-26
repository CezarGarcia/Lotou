import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { KAFKA_PRODUCER } from '../kafka/kafka.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxRelay } from '../outbox/outbox.relay.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PaymentsService } from '../payments/payments.service.js';
import { CommandConsumer } from './command.consumer.js';
import { CommandProcessor } from './command.processor.js';
import { DeadLetterPublisher } from './dead-letter.publisher.js';
import {
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_TRANSIENT_BUDGET_MS,
} from './retry-policy.js';

/**
 * Liga e desliga a mensageria na ordem certa. Na subida (depois das
 * migrações), primeiro o relay, para publicar o que ficou pendente, depois o
 * consumidor. Na parada, ao contrário: o consumidor para de receber e confirma
 * os offsets, e o relay publica o último lote; o produtor e o pool fecham
 * depois (onApplicationShutdown).
 */
@Injectable()
class MessagingLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    private readonly consumer: CommandConsumer,
    private readonly relay: OutboxRelay,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.relay.start();
    await this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
    await this.relay.stop();
  }
}

@Module({
  imports: [PaymentsModule, OutboxModule],
  providers: [
    {
      provide: DeadLetterPublisher,
      inject: [KAFKA_PRODUCER],
      useFactory: (producer: KafkaJS.Producer) =>
        new DeadLetterPublisher(producer),
    },
    {
      provide: CommandProcessor,
      inject: [PaymentsService, DeadLetterPublisher, ConfigService],
      useFactory: (
        payments: PaymentsService,
        deadLetters: DeadLetterPublisher,
        config: ConfigService<Env, true>,
      ) =>
        new CommandProcessor(payments, deadLetters, {
          maxAttempts: config.get('CONSUMER_MAX_ATTEMPTS', { infer: true }),
          initialBackoffMs: config.get('CONSUMER_RETRY_BACKOFF_MS', {
            infer: true,
          }),
          maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
          transientBudgetMs: DEFAULT_TRANSIENT_BUDGET_MS,
        }),
    },
    CommandConsumer,
    MessagingLifecycle,
  ],
})
export class ConsumerModule {}

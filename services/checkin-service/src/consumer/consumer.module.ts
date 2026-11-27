import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  type BeforeApplicationShutdown,
  Injectable,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CheckinModule } from '../checkin/checkin.module.js';
import { RejectionBuffer } from '../checkin/rejection-buffer.js';
import type { Env } from '../config/env.js';
import { KAFKA_PRODUCER } from '../kafka/kafka.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { OutboxRelay } from '../outbox/outbox.relay.js';
import { LocalCopyService } from '../tickets/local-copy.service.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import { DeadLetterPublisher } from './dead-letter.publisher.js';
import { MessageConsumer } from './message.consumer.js';
import { MessageProcessor } from './message.processor.js';
import {
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_TRANSIENT_BUDGET_MS,
} from './retry-policy.js';

/**
 * Liga e desliga a mensageria na ordem certa. Na subida (depois das
 * migrações), primeiro o relay, para publicar o que ficou pendente, depois a
 * gravação das recusas e o consumidor. Na parada, ao contrário: o consumidor
 * para de receber e confirma os offsets, as recusas em memória vão para o
 * outbox, e o relay publica o último lote; o produtor e o pool fecham depois
 * (onApplicationShutdown).
 */
@Injectable()
class MessagingLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    private readonly consumer: MessageConsumer,
    private readonly rejections: RejectionBuffer,
    private readonly relay: OutboxRelay,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.relay.start();
    this.rejections.start();
    await this.consumer.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
    await this.rejections.stop();
    await this.relay.stop();
  }
}

@Module({
  imports: [TicketsModule, OutboxModule, CheckinModule],
  providers: [
    {
      provide: DeadLetterPublisher,
      inject: [KAFKA_PRODUCER],
      useFactory: (producer: KafkaJS.Producer) =>
        new DeadLetterPublisher(producer),
    },
    {
      provide: MessageProcessor,
      inject: [LocalCopyService, DeadLetterPublisher, ConfigService],
      useFactory: (
        localCopy: LocalCopyService,
        deadLetters: DeadLetterPublisher,
        config: ConfigService<Env, true>,
      ) =>
        new MessageProcessor(localCopy, deadLetters, {
          maxAttempts: config.get('CONSUMER_MAX_ATTEMPTS', { infer: true }),
          initialBackoffMs: config.get('CONSUMER_RETRY_BACKOFF_MS', {
            infer: true,
          }),
          maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
          transientBudgetMs: DEFAULT_TRANSIENT_BUDGET_MS,
        }),
    },
    MessageConsumer,
    MessagingLifecycle,
  ],
})
export class ConsumerModule {}

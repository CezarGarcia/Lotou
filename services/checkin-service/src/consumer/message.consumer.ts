import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { KAFKA } from '../kafka/kafka.module.js';
import { CONSUMED_TOPICS, CONSUMER_GROUP } from '../kafka/topics.js';
import { MessageProcessor } from './message.processor.js';

/**
 * Consumidor de `order.events` e `shows.catalog`, no grupo `checkin-service`.
 *
 * - **Desde o começo:** um grupo novo lê os dois tópicos do início. A portaria
 *   precisa de todo ingresso já emitido, e o catálogo é compactado (fica a
 *   última versão de cada show).
 * - **Só o que foi confirmado** (`read_committed`): uma mensagem de uma
 *   transação do produtor que foi abortada nunca vira ingresso válido.
 * - **Pelo menos uma vez:** o offset só é guardado depois que a mensagem
 *   termina (aplicada, ignorada ou na DLT). Se o processo cair antes, ela chega
 *   de novo e o `processed_events` (ou a versão do show) a reconhece.
 *
 * As partições são processadas em paralelo (`CONSUMER_CONCURRENCY`), cada uma
 * em ordem: tudo de um pedido (a chave de `order.events`) chega em ordem, e o
 * `TicketsCancelled` nunca passa na frente do `TicketsIssued`.
 */
@Injectable()
export class MessageConsumer {
  private readonly logger = new Logger(MessageConsumer.name);
  private readonly concurrency: number;
  private consumer?: KafkaJS.Consumer;

  constructor(
    @Inject(KAFKA) private readonly kafka: KafkaJS.Kafka,
    private readonly processor: MessageProcessor,
    config: ConfigService<Env, true>,
  ) {
    this.concurrency = config.get('CONSUMER_CONCURRENCY', { infer: true });
  }

  async start(): Promise<void> {
    const consumer = this.kafka.consumer({
      kafkaJS: {
        groupId: CONSUMER_GROUP,
        fromBeginning: true,
        readUncommitted: false,
        autoCommit: true,
        autoCommitInterval: 1_000,
        partitionAssigners: [KafkaJS.PartitionAssigners.cooperativeSticky],
      },
    });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topics: [...CONSUMED_TOPICS] });
    await consumer.run({
      partitionsConsumedConcurrently: this.concurrency,
      eachMessage: ({ topic, partition, message }) =>
        this.processor.process({
          topic,
          partition,
          offset: message.offset,
          key: message.key,
          value: message.value,
          headers: message.headers,
        }),
    });
    this.logger.log(
      `Consumindo ${CONSUMED_TOPICS.join(' e ')} no grupo ${CONSUMER_GROUP} (${this.concurrency} partições em paralelo)`,
    );
  }

  /** Para de consumir e confirma os offsets do que já foi processado. */
  async stop(): Promise<void> {
    this.processor.stop();
    await this.consumer?.disconnect();
    this.consumer = undefined;
  }
}

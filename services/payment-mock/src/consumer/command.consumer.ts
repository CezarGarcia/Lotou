import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { KAFKA } from '../kafka/kafka.module.js';
import { CONSUMER_GROUP, TOPICS } from '../kafka/topics.js';
import { CommandProcessor } from './command.processor.js';

/**
 * Consumidor de `payment.commands`, no grupo `payment-mock`.
 *
 * Entrega pelo menos uma vez: o offset de uma mensagem só é guardado depois
 * que o processamento termina (com a resposta no outbox, a mensagem ignorada
 * ou enviada para a DLT), e confirmado ao broker a cada segundo e ao parar. Se
 * o processo cair antes, a mensagem chega de novo e o `processed_events` a
 * reconhece.
 *
 * As partições são processadas em paralelo (`CONSUMER_CONCURRENCY`), mas cada
 * uma em ordem: os comandos de um mesmo pedido, que têm a mesma chave, nunca
 * são processados ao mesmo tempo nesta instância.
 */
@Injectable()
export class CommandConsumer {
  private readonly logger = new Logger(CommandConsumer.name);
  private readonly concurrency: number;
  private consumer?: KafkaJS.Consumer;

  constructor(
    @Inject(KAFKA) private readonly kafka: KafkaJS.Kafka,
    private readonly processor: CommandProcessor,
    config: ConfigService<Env, true>,
  ) {
    this.concurrency = config.get('CONSUMER_CONCURRENCY', { infer: true });
  }

  async start(): Promise<void> {
    const consumer = this.kafka.consumer({
      kafkaJS: {
        groupId: CONSUMER_GROUP,
        // Grupo novo lê o tópico desde o começo: nenhum comando se perde
        // porque o serviço ainda não existia quando ele foi enviado.
        fromBeginning: true,
        autoCommit: true,
        autoCommitInterval: 1_000,
        partitionAssigners: [KafkaJS.PartitionAssigners.cooperativeSticky],
      },
    });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topics: [TOPICS.commands] });
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
      `Consumindo ${TOPICS.commands} no grupo ${CONSUMER_GROUP} (${this.concurrency} partições em paralelo)`,
    );
  }

  /** Para de consumir e confirma os offsets do que já foi processado. */
  async stop(): Promise<void> {
    this.processor.stop();
    await this.consumer?.disconnect();
    this.consumer = undefined;
  }
}

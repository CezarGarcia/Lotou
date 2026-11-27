import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import { type Counter, metrics } from '@opentelemetry/api';
import type { IncomingMessage } from './incoming-message.js';

/** O texto do erro vai num cabeçalho; mais que isso não ajuda a investigar. */
const MAX_ERROR_LENGTH = 1_000;

/**
 * Publica na DLT (`<tópico>.dlt`) a mensagem que não pôde ser processada:
 * mesma chave, mesmo valor (byte a byte) e os cabeçalhos originais, mais o de
 * onde veio e por que falhou. Espera o `ack`: só depois disso o offset da
 * original é confirmado.
 */
export class DeadLetterPublisher {
  private readonly logger = new Logger(DeadLetterPublisher.name);
  private readonly counter: Counter = metrics
    .getMeter('lotou.checkin-service')
    .createCounter('kafka_dlt_messages_total', {
      description: 'Mensagens enviadas para a DLT, por tópico de origem',
    });

  constructor(private readonly producer: Pick<KafkaJS.Producer, 'send'>) {}

  async publish(
    message: IncomingMessage,
    error: Error,
    attempts: number,
  ): Promise<void> {
    const topic = `${message.topic}.dlt`;
    await this.producer.send({
      topic,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            ...message.headers,
            'dlt.original.topic': message.topic,
            'dlt.original.partition': String(message.partition),
            'dlt.original.offset': message.offset,
            'dlt.error.class': error.name,
            'dlt.error.message': error.message.slice(0, MAX_ERROR_LENGTH),
            'dlt.attempts': String(attempts),
            'dlt.failed.at': new Date().toISOString(),
          },
        },
      ],
    });
    this.counter.add(1, { topic: message.topic });
    this.logger.error(
      `Mensagem ${message.topic}/${message.partition}@${message.offset} enviada para ${topic} depois de ${attempts} tentativa(s): ${error.name}: ${error.message}`,
    );
  }
}

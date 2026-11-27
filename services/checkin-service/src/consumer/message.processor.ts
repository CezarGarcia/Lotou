import { Logger } from '@nestjs/common';
import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { setTimeout as sleep } from 'node:timers/promises';
import { NonRetryableError, PoisonMessageError } from '../common/errors.js';
import { isTransientError } from '../database/transient-errors.js';
import { CONSUMER_GROUP } from '../kafka/topics.js';
import { extractContext } from '../kafka/trace-headers.js';
import {
  type KnownMessage,
  type ParsedMessage,
  parseMessage,
} from '../messages/incoming.js';
import type { DeadLetterPublisher } from './dead-letter.publisher.js';
import type { IncomingMessage } from './incoming-message.js';
import { type RetryPolicy, retryDelayMs } from './retry-policy.js';

const tracer = trace.getTracer('lotou.checkin-service');

/** Quem aplica a mensagem (a cópia local dos ingressos e do catálogo). */
export interface MessageHandler {
  handle(message: KnownMessage): Promise<unknown>;
}

/**
 * Processa uma mensagem de `order.events` ou de `shows.catalog`, do jeito que
 * o consumidor a recebe. Devolver normalmente confirma o offset; lançar faz o
 * cliente do Kafka entregar a mesma mensagem de novo.
 *
 * | Situação                                   | O que acontece                              |
 * | ------------------------------------------ | ------------------------------------------- |
 * | tipo que a portaria não usa                | ignora (log em debug) e segue               |
 * | JSON inválido, payload fora do contrato    | DLT na hora, sem nova tentativa             |
 * | erro que não passa                         | DLT na hora                                 |
 * | falha passageira (Postgres fora, rede)     | tenta de novo com backoff, nunca vai à DLT  |
 * | outro erro                                 | `maxAttempts` tentativas com backoff, e DLT |
 *
 * A DLT só é confirmada depois do `ack` do broker; se ela falhar, a mensagem
 * original não é confirmada e volta.
 */
export class MessageProcessor {
  private readonly logger = new Logger(MessageProcessor.name);
  private readonly stopping = new AbortController();

  constructor(
    private readonly handler: MessageHandler,
    private readonly deadLetters: Pick<DeadLetterPublisher, 'publish'>,
    private readonly policy: RetryPolicy,
  ) {}

  /** Interrompe as esperas entre tentativas: a mensagem em curso não é confirmada. */
  stop(): void {
    this.stopping.abort();
  }

  /**
   * Um span de consumidor por mensagem, filho do trace que veio no cabeçalho
   * `traceparent`: o trace do order-service (ou do event-service) continua aqui.
   */
  async process(message: IncomingMessage): Promise<void> {
    return tracer.startActiveSpan(
      `process ${message.topic}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.operation.type': 'process',
          'messaging.destination.name': message.topic,
          'messaging.destination.partition.id': String(message.partition),
          'messaging.kafka.offset': Number(message.offset),
          'messaging.consumer.group.name': CONSUMER_GROUP,
          ...(message.key && {
            'messaging.kafka.message.key': message.key.toString(),
          }),
        },
      },
      extractContext(message.headers),
      async (span) => {
        try {
          await this.processInSpan(message, span);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  }

  private async processInSpan(
    message: IncomingMessage,
    span: Span,
  ): Promise<void> {
    let parsed: ParsedMessage;
    try {
      parsed = parseMessage(message.topic, message.value);
    } catch (error) {
      if (error instanceof PoisonMessageError) {
        await this.deadLetter(message, error, 1, span);
        return;
      }
      throw error;
    }

    if (parsed.kind === 'ignored') {
      span.setAttribute('messaging.message.id', parsed.eventId);
      span.setAttribute('lotou.message.type', parsed.type);
      span.setAttribute('lotou.message.ignored', true);
      this.logger.debug(
        `${parsed.type} v${parsed.version} (${parsed.eventId}) não é usado pela portaria; ignorado`,
      );
      return;
    }

    const known = parsed.message;
    span.setAttribute('messaging.message.id', known.eventId);
    span.setAttribute('lotou.message.type', known.type);
    span.setAttribute('lotou.show.id', known.payload.showId);
    await this.handleWithRetries(known, message, span);
  }

  private async handleWithRetries(
    known: KnownMessage,
    message: IncomingMessage,
    span: Span,
  ): Promise<void> {
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.handler.handle(known);
        return;
      } catch (caught) {
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        if (this.stopping.signal.aborted) {
          throw error;
        }
        if (error instanceof NonRetryableError) {
          await this.deadLetter(message, error, attempt, span);
          return;
        }

        const delay = retryDelayMs(attempt, this.policy);
        const what = `${known.type} ${known.eventId}`;
        if (isTransientError(error)) {
          // Falha de infraestrutura: a mensagem não tem defeito e não vai
          // para a DLT. Passado o orçamento, volta ao Kafka sem confirmar.
          if (Date.now() - startedAt + delay > this.policy.transientBudgetMs) {
            this.logger.warn(
              `${what}: falha passageira persistente, a mensagem será entregue de novo: ${error.message}`,
            );
            throw error;
          }
          this.logger.warn(
            `${what}: falha passageira na tentativa ${attempt}, nova em ${delay} ms: ${error.message}`,
          );
        } else if (attempt >= this.policy.maxAttempts) {
          await this.deadLetter(message, error, attempt, span);
          return;
        } else {
          this.logger.warn(
            `${what}: tentativa ${attempt} de ${this.policy.maxAttempts} falhou, nova em ${delay} ms: ${error.message}`,
          );
        }
        await sleep(delay, undefined, { signal: this.stopping.signal });
      }
    }
  }

  private async deadLetter(
    message: IncomingMessage,
    error: Error,
    attempts: number,
    span: Span,
  ): Promise<void> {
    span.recordException(error);
    span.setAttribute('lotou.message.dead_lettered', true);
    await this.deadLetters.publish(message, error, attempts);
  }
}

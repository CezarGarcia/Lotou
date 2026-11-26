import { Logger } from '@nestjs/common';
import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { setTimeout as sleep } from 'node:timers/promises';
import { NonRetryableError, PoisonMessageError } from '../common/errors.js';
import { isTransientError } from '../database/transient-errors.js';
import { CONSUMER_GROUP } from '../kafka/topics.js';
import {
  extractContext,
  type TraceHeaders,
  traceHeadersFrom,
  traceHeadersOf,
} from '../kafka/trace-headers.js';
import {
  type PaymentCommand,
  type ParsedMessage,
  parseMessage,
} from '../messages/commands.js';
import type { DeadLetterPublisher } from './dead-letter.publisher.js';
import type { IncomingMessage } from './incoming-message.js';
import { type RetryPolicy, retryDelayMs } from './retry-policy.js';

const tracer = trace.getTracer('lotou.payment-mock');

/** Quem aplica o comando (o PaymentsService). */
export interface CommandHandler {
  handle(command: PaymentCommand, trace: TraceHeaders): Promise<unknown>;
}

/**
 * Processa uma mensagem de `payment.commands`, do jeito que o consumidor a
 * recebe. Devolver normalmente confirma o offset; lançar faz o cliente do
 * Kafka entregar a mesma mensagem de novo.
 *
 * | Situação                                   | O que acontece                              |
 * | ------------------------------------------ | ------------------------------------------- |
 * | tipo ou versão desconhecida                | ignora (log em debug) e segue               |
 * | JSON inválido, payload fora do contrato    | DLT na hora, sem nova tentativa             |
 * | erro que não passa (transição inválida)    | DLT na hora                                 |
 * | falha passageira (Postgres fora, rede)     | tenta de novo com backoff, nunca vai à DLT  |
 * | outro erro                                 | `maxAttempts` tentativas com backoff, e DLT |
 *
 * A DLT só é confirmada depois do `ack` do broker; se ela falhar, a mensagem
 * original não é confirmada e volta.
 */
export class CommandProcessor {
  private readonly logger = new Logger(CommandProcessor.name);
  private readonly stopping = new AbortController();

  constructor(
    private readonly handler: CommandHandler,
    private readonly deadLetters: Pick<DeadLetterPublisher, 'publish'>,
    private readonly policy: RetryPolicy,
  ) {}

  /** Interrompe as esperas entre tentativas: a mensagem em curso não é confirmada. */
  stop(): void {
    this.stopping.abort();
  }

  /**
   * Um span de consumidor por mensagem, filho do trace que veio no cabeçalho
   * `traceparent`: o trace do order-service continua aqui.
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
      parsed = parseMessage(message.value);
    } catch (error) {
      if (error instanceof PoisonMessageError) {
        await this.deadLetter(message, error, 1, span);
        return;
      }
      throw error;
    }

    if (parsed.kind === 'unknown') {
      span.setAttribute('messaging.message.id', parsed.eventId);
      span.setAttribute('lotou.message.ignored', true);
      this.logger.debug(
        `Tipo desconhecido ${parsed.type} v${parsed.version} (${parsed.eventId}); ignorado`,
      );
      return;
    }

    const { command } = parsed;
    span.setAttribute('messaging.message.id', command.eventId);
    span.setAttribute('lotou.message.type', command.type);
    span.setAttribute('lotou.order.id', command.payload.orderId);
    // O trace da resposta é o deste span, calculado aqui e passado adiante:
    // o contexto ativo não sobrevive a todo callback do driver do Postgres.
    // Sem o SDK, segue o `traceparent` que veio no comando.
    const answerTrace = traceHeadersFrom(
      traceHeadersOf(message.headers),
      trace.setSpan(context.active(), span),
    );
    await this.handleWithRetries(command, answerTrace, message, span);
  }

  private async handleWithRetries(
    command: PaymentCommand,
    answerTrace: TraceHeaders,
    message: IncomingMessage,
    span: Span,
  ): Promise<void> {
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.handler.handle(command, answerTrace);
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
        const what = `${command.type} ${command.eventId} (pedido ${command.payload.orderId})`;
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

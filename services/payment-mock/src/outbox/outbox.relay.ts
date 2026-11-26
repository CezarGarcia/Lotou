import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  propagation,
  ROOT_CONTEXT,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { Env } from '../config/env.js';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import { KAFKA_PRODUCER } from '../kafka/kafka.module.js';
import { traceHeadersFrom } from '../kafka/trace-headers.js';
import {
  lockPending,
  markPublished,
  type OutboxRow,
} from './outbox.repository.js';

const tracer = trace.getTracer('lotou.payment-mock');

/** Espera máxima entre tentativas depois de falhas seguidas. */
const MAX_BACKOFF_MS = 5_000;

/**
 * Relay do outbox: publica no Kafka as mensagens gravadas junto com os
 * pagamentos e as marca como publicadas.
 *
 * Cada lote é uma transação: trava as linhas, envia e espera o `ack` do
 * broker, marca e confirma. Se o envio falha, a transação desfaz e as linhas
 * ficam para a próxima volta. Se o processo cai entre o envio e a confirmação,
 * a mensagem sai de novo, com o mesmo `eventId`; o consumidor a reconhece como
 * repetida. É entrega pelo menos uma vez, como em todo o projeto.
 *
 * O relay acorda a cada `OUTBOX_POLL_INTERVAL_MS` ou quando avisado por
 * `notify()`, logo depois de um pagamento ser gravado.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;

  private loop?: Promise<void>;
  private stopped = true;
  private nudged = false;
  private wake?: () => void;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(KAFKA_PRODUCER) private readonly producer: KafkaJS.Producer,
    config: ConfigService<Env, true>,
  ) {
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
  }

  start(): void {
    if (this.loop) {
      return;
    }
    this.stopped = false;
    this.loop = this.run();
  }

  /** Para depois do lote em andamento; o que ficou pendente sai na próxima subida. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  /** Há mensagem nova no outbox: publica sem esperar o próximo intervalo. */
  notify(): void {
    this.nudged = true;
    this.wake?.();
  }

  /**
   * Publica um lote. Devolve quantas mensagens saíram; zero quando não há
   * nada pendente (ou o que há está com outra instância).
   */
  async publishPending(): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const rows = await lockPending(client, this.batchSize);
      if (rows.length === 0) {
        return 0;
      }
      await this.send(rows);
      await markPublished(
        client,
        rows.map((row) => row.id),
      );
      return rows.length;
    });
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (!this.stopped) {
      try {
        const sent = await this.publishPending();
        failures = 0;
        // Lote cheio ou não, volta logo se publicou algo: pode haver a
        // mensagem seguinte de uma chave que só sai depois da anterior.
        if (sent === 0) {
          await this.idle(this.pollIntervalMs, true);
        }
      } catch (error) {
        failures += 1;
        const backoff = Math.min(
          this.pollIntervalMs * 2 ** (failures - 1),
          MAX_BACKOFF_MS,
        );
        this.logger.warn(
          `Falha ao publicar o outbox (${failures}ª seguida), nova tentativa em ${backoff} ms: ${(error as Error).message}`,
        );
        await this.idle(backoff, false);
      }
    }
  }

  /** Espera o intervalo; `notify()` encurta a espera se `wakeOnNotify`. */
  private idle(ms: number, wakeOnNotify: boolean): Promise<void> {
    if (this.stopped || (wakeOnNotify && this.nudged)) {
      this.nudged = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        if (wakeOnNotify) {
          this.nudged = false;
        }
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = () => {
        if (this.stopped || wakeOnNotify) {
          done();
        }
      };
    });
  }

  /**
   * Envia o lote e espera o `ack`. Cada mensagem ganha um span de produtor,
   * filho do trace do comando que a causou (guardado na linha), e leva o
   * contexto desse span no cabeçalho `traceparent`: o trace segue pelo broker
   * até o order-service.
   */
  private async send(rows: OutboxRow[]): Promise<void> {
    const spans: Span[] = [];
    const byTopic = new Map<string, KafkaJS.Message[]>();
    for (const row of rows) {
      const parent = propagation.extract(ROOT_CONTEXT, row.headers);
      const span = tracer.startSpan(
        `send ${row.topic}`,
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            'messaging.system': 'kafka',
            'messaging.operation.type': 'send',
            'messaging.destination.name': row.topic,
            'messaging.message.id': row.id,
            'messaging.kafka.message.key': row.message_key,
            'lotou.message.type': row.type,
          },
        },
        parent,
      );
      spans.push(span);
      const headers = traceHeadersFrom(
        row.headers,
        trace.setSpan(parent, span),
      );
      const messages = byTopic.get(row.topic) ?? [];
      messages.push({
        key: row.message_key,
        value: JSON.stringify(row.payload),
        headers: { ...headers },
      });
      byTopic.set(row.topic, messages);
    }

    try {
      await this.producer.sendBatch({
        topicMessages: [...byTopic].map(([topic, messages]) => ({
          topic,
          messages,
        })),
      });
    } catch (error) {
      for (const span of spans) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      throw error;
    } finally {
      for (const span of spans) {
        span.end();
      }
    }
  }
}

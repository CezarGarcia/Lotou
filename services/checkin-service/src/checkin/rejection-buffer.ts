import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Link,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import type { Pool } from 'pg';
import type { Env } from '../config/env.js';
import { PG_POOL } from '../database/database.module.js';
import { withTransaction } from '../database/transaction.js';
import { TOPICS } from '../kafka/topics.js';
import type { TraceHeaders } from '../kafka/trace-headers.js';
import { checkinRejected, type Rejection } from '../messages/checkin-events.js';
import { enqueue } from '../outbox/outbox.repository.js';
import { OutboxRelay } from '../outbox/outbox.relay.js';
import { CheckinMetrics } from './checkin-metrics.js';
import { insertRejections } from './checkins.repository.js';

const tracer = trace.getTracer('lotou.checkin-service');

/** Recusas gravadas por transação. */
const BATCH_SIZE = 500;
/**
 * Teto da fila em memória enquanto o banco está fora. Passado isso, as mais
 * antigas são descartadas (e contadas em `checkin_rejections_dropped_total`):
 * a portaria não pode ficar sem memória por causa de um QR falso repetido.
 */
const MAX_PENDING = 20_000;

interface PendingRejection {
  rejection: Rejection;
  trace: TraceHeaders;
}

/**
 * As leituras recusadas vão para o banco em lote, fora da requisição: a
 * linha em `checkin_rejections` (para o resumo da portaria) e o
 * `CheckinRejected` no outbox, juntos numa transação a cada
 * `REJECTION_FLUSH_INTERVAL_MS`.
 *
 * É o que deixa um QR falsificado ser recusado sem tocar no banco (ADR 15):
 * a resposta sai antes de a recusa ser gravada. E um portão sob uma enxurrada
 * de códigos falsos não abre uma transação por leitura. O preço: se o
 * processo cair, as recusas do último intervalo se perdem. Uma recusa não
 * muda estado nenhum; a entrada liberada, que muda, é gravada na hora, na
 * mesma transação do seu evento.
 */
@Injectable()
export class RejectionBuffer {
  private readonly logger = new Logger(RejectionBuffer.name);
  private readonly intervalMs: number;
  private pending: PendingRejection[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<number>;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly relay: OutboxRelay,
    private readonly metrics: CheckinMetrics,
    config: ConfigService<Env, true>,
  ) {
    this.intervalMs = config.get('REJECTION_FLUSH_INTERVAL_MS', {
      infer: true,
    });
  }

  /** Recusas à espera de gravação. */
  get size(): number {
    return this.pending.length;
  }

  add(rejection: Rejection, trace: TraceHeaders): void {
    this.pending.push({ rejection, trace });
    const excess = this.pending.length - MAX_PENDING;
    if (excess > 0) {
      this.pending.splice(0, excess);
      this.metrics.rejectionsDropped(excess);
    }
  }

  start(): void {
    this.timer ??= setInterval(() => {
      void this.flush().catch(() => undefined);
    }, this.intervalMs);
  }

  /** Para o timer e grava o que ficou; o que não couber fica no log. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      while (this.pending.length > 0 && (await this.flush()) > 0) {
        // Grava os lotes que restam.
      }
    } catch (error) {
      this.logger.error(
        `${this.pending.length} recusa(s) não gravada(s) ao parar: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Grava um lote. Uma volta por vez: se a anterior ainda está gravando, espera
   * por ela. Devolve quantas recusas foram gravadas.
   */
  async flush(): Promise<number> {
    while (this.flushing) {
      await this.flushing.catch(() => undefined);
    }
    if (this.pending.length === 0) {
      return 0;
    }
    this.flushing = this.write().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  private async write(): Promise<number> {
    const batch = this.pending.slice(0, BATCH_SIZE);
    try {
      await tracer.startActiveSpan(
        'flush checkin rejections',
        {
          kind: SpanKind.INTERNAL,
          attributes: { 'lotou.checkin.rejections': batch.length },
          // O lote não tem um pai só: cada recusa aponta para a leitura dela.
          links: linksTo(batch),
        },
        async (span) => {
          try {
            await withTransaction(this.pool, async (client) => {
              await insertRejections(
                client,
                batch.map(({ rejection }) => rejection),
              );
              await enqueue(
                client,
                ...batch.map(({ rejection, trace }) => ({
                  topic: TOPICS.checkinEvents,
                  key: rejection.showId,
                  event: checkinRejected(rejection),
                  headers: trace,
                })),
              );
            });
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    } catch (error) {
      // As recusas ficam na fila e vão na próxima volta.
      this.logger.warn(
        `Falha ao gravar ${batch.length} recusa(s); nova tentativa em ${this.intervalMs} ms: ${(error as Error).message}`,
      );
      throw error;
    }
    // Só sai da fila o que foi gravado; o que chegou nesse meio-tempo fica.
    const written = new Set(batch);
    this.pending = this.pending.filter((item) => !written.has(item));
    this.relay.notify();
    return batch.length;
  }
}

function linksTo(batch: PendingRejection[]): Link[] {
  const links: Link[] = [];
  for (const { trace: headers } of batch) {
    const context = trace.getSpanContext(
      propagation.extract(ROOT_CONTEXT, headers),
    );
    if (context) {
      links.push({ context });
    }
  }
  return links;
}

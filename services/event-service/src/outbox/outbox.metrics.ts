import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Counter, metrics } from '@opentelemetry/api';
import type { Model } from 'mongoose';
import { OutboxMessage } from './outbox.schema.js';

/**
 * Métricas do outbox. Usa a API do OpenTelemetry; sem o SDK (testes), não faz
 * nada e os gauges nunca consultam o banco.
 *
 * - `outbox_published_total{topic, type}`: mensagens publicadas no Kafka.
 * - `outbox_publish_failures_total{topic}`: lotes que falharam (o relay tenta
 *   de novo na rodada seguinte).
 * - `outbox_pending`: mensagens esperando o relay.
 * - `outbox_oldest_pending_age_seconds`: idade da pendente mais antiga; é o
 *   atraso do catálogo no Kafka. Subindo sem parar, o relay está parado.
 *
 * Os gauges contam o outbox inteiro, então todas as instâncias informam o
 * mesmo valor: no painel, use `max`, não `sum`.
 */
@Injectable()
export class OutboxMetrics {
  private readonly logger = new Logger(OutboxMetrics.name);
  private readonly meter = metrics.getMeter('lotou.event');
  private readonly published: Counter = this.meter.createCounter(
    'outbox_published_total',
    { description: 'Mensagens do outbox publicadas no Kafka' },
  );
  private readonly failures: Counter = this.meter.createCounter(
    'outbox_publish_failures_total',
    { description: 'Lotes do outbox que falharam ao publicar' },
  );

  constructor(
    @InjectModel(OutboxMessage.name)
    private readonly messages: Model<OutboxMessage>,
  ) {
    const pending = this.meter.createObservableGauge('outbox_pending', {
      description: 'Mensagens do outbox ainda não publicadas',
    });
    const oldestAge = this.meter.createObservableGauge(
      'outbox_oldest_pending_age_seconds',
      {
        description: 'Idade da mensagem pendente mais antiga do outbox',
        unit: 's',
      },
    );
    this.meter.addBatchObservableCallback(
      async (result) => {
        try {
          const [count, oldest] = await Promise.all([
            this.messages.countDocuments({ publishedAt: null }),
            this.messages
              .findOne({ publishedAt: null }, { createdAt: 1 })
              .sort({ createdAt: 1 })
              .lean(),
          ]);
          result.observe(pending, count);
          result.observe(
            oldestAge,
            oldest ? (Date.now() - oldest.createdAt.getTime()) / 1000 : 0,
          );
        } catch (error) {
          this.logger.debug(
            `Leitura das métricas do outbox falhou: ${String(error)}`,
          );
        }
      },
      [pending, oldestAge],
    );
  }

  recordPublished(topic: string, type: string, count = 1): void {
    this.published.add(count, { topic, type });
  }

  recordFailure(topic: string): void {
    this.failures.add(1, { topic });
  }
}

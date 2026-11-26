import { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type Counter,
  metrics,
  SpanKind,
  SpanStatusCode,
} from '@opentelemetry/api';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Env } from '../config/env.js';
import { headersAsText, TOPICS } from '../kafka/kafka.js';
import { KAFKA } from '../kafka/kafka.module.js';
import { ShowPageCache } from '../shows/cache/show-page.cache.js';
import { contextFrom, tracer } from '../telemetry/trace-context.js';
import {
  handleInventoryEvent,
  type InventoryEventOutcome,
} from './inventory-event.handler.js';

/** Espera entre tentativas de subir o consumidor com o Kafka fora. */
const RESTART_DELAY_MS = 5_000;

/**
 * Cabeçalhos da mensagem na DLT, com os mesmos nomes do Spring Kafka
 * (`DeadLetterPublishingRecoverer`), para a inspeção ser igual em todos os
 * serviços.
 */
const DLT_HEADERS = {
  topic: 'kafka_dlt-original-topic',
  partition: 'kafka_dlt-original-partition',
  offset: 'kafka_dlt-original-offset',
  group: 'kafka_dlt-original-consumer-group',
  reason: 'kafka_dlt-exception-message',
} as const;

/**
 * Consome `inventory.events` no grupo `event-service` e, em `LotSoldOut` e
 * `LotOpened`, apaga o cache da página do show (Fluxo C).
 *
 * Pelo menos uma vez: o offset só é confirmado depois do tratamento (commit
 * automático dos offsets já tratados). Uma mensagem que falha em todas as
 * tentativas vai para `inventory.events.dlt` e a partição segue; se nem a DLT
 * aceitar, a mensagem é lida de novo.
 *
 * Um grupo novo começa do início do tópico: apagar o cache de shows antigos
 * não faz mal, e nenhum evento se perde entre a criação do grupo e a primeira
 * leitura.
 */
@Injectable()
export class InventoryEventsConsumer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(InventoryEventsConsumer.name);
  private readonly enabled: boolean;
  private readonly groupId: string;
  private readonly consumed: Counter = metrics
    .getMeter('lotou.event')
    .createCounter('kafka_messages_consumed_total', {
      description:
        'Mensagens lidas do Kafka, por tópico, tipo e resultado (processed, ignored, dead_lettered)',
    });
  private consumer?: KafkaJS.Consumer;
  private deadLetters?: Promise<KafkaJS.Producer>;
  private starting?: Promise<void>;
  private stopped = false;
  private readonly stopping = new AbortController();

  constructor(
    @Inject(KAFKA) private readonly kafka: KafkaJS.Kafka,
    private readonly pageCache: ShowPageCache,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('INVENTORY_EVENTS_CONSUMER_ENABLED', {
      infer: true,
    });
    this.groupId = config.get('KAFKA_CONSUMER_GROUP', { infer: true });
  }

  onApplicationBootstrap(): void {
    // Em segundo plano: a API sobe e atende mesmo com o Kafka fora.
    if (this.enabled) {
      this.starting = this.start();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.stopping.abort();
    // Fechar o consumidor também interrompe uma conexão ainda em andamento.
    await this.consumer?.disconnect().catch(() => undefined);
    await this.starting;
    const producer = await this.deadLetters?.catch(() => undefined);
    await producer?.disconnect().catch(() => undefined);
  }

  private async start(): Promise<void> {
    while (!this.stopped) {
      const consumer = this.kafka.consumer({
        kafkaJS: {
          groupId: this.groupId,
          fromBeginning: true,
          autoCommit: true,
        },
      });
      this.consumer = consumer;
      try {
        await consumer.connect();
        await consumer.subscribe({ topics: [TOPICS.inventoryEvents] });
        await consumer.run({
          eachMessage: (payload) => this.consume(payload),
        });
        return;
      } catch (error) {
        if (this.stopped) {
          return;
        }
        this.logger.warn({
          msg: `Falha ao consumir ${TOPICS.inventoryEvents}; nova tentativa em ${RESTART_DELAY_MS} ms`,
          error: String(error),
        });
        await consumer.disconnect().catch(() => undefined);
        await sleep(RESTART_DELAY_MS, undefined, {
          signal: this.stopping.signal,
        }).catch(() => undefined);
      }
    }
  }

  /** Uma mensagem, num span de consumidor que continua o trace do produtor. */
  private async consume({
    topic,
    partition,
    message,
  }: KafkaJS.EachMessagePayload): Promise<void> {
    const parent = contextFrom(headersAsText(message.headers));
    await tracer.startActiveSpan(
      `process ${topic}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.operation.type': 'process',
          'messaging.operation.name': 'process',
          'messaging.destination.name': topic,
          'messaging.consumer.group.name': this.groupId,
          'messaging.destination.partition.id': String(partition),
          'messaging.kafka.offset': Number(message.offset),
          ...(message.key && {
            'messaging.kafka.message.key': message.key.toString(),
          }),
        },
      },
      parent,
      async (span) => {
        try {
          const outcome = await handleInventoryEvent(message.value, (showId) =>
            this.pageCache.invalidate(showId),
          );
          span.setAttribute('lotou.message.result', outcome.result);
          if (outcome.eventId) {
            span.setAttribute('messaging.message.id', outcome.eventId);
          }
          if (outcome.result === 'dead_lettered') {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: outcome.reason,
            });
            // Se a DLT falhar, a exceção faz a mensagem ser lida de novo.
            await this.deadLetter(topic, partition, message, outcome);
          }
          this.consumed.add(1, {
            topic,
            type: outcome.type ?? 'unknown',
            result: outcome.result,
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
  }

  private async deadLetter(
    topic: string,
    partition: number,
    message: KafkaJS.KafkaMessage,
    outcome: Extract<InventoryEventOutcome, { result: 'dead_lettered' }>,
  ): Promise<void> {
    this.logger.warn({
      msg: 'Mensagem enviada para a DLT',
      topic,
      partition,
      offset: message.offset,
      type: outcome.type,
      eventId: outcome.eventId,
      reason: outcome.reason,
    });
    const producer = await this.deadLetterProducer();
    await producer.send({
      topic: TOPICS.inventoryEventsDlt,
      messages: [
        {
          key: message.key,
          value: message.value,
          headers: {
            ...message.headers,
            [DLT_HEADERS.topic]: topic,
            [DLT_HEADERS.partition]: String(partition),
            [DLT_HEADERS.offset]: message.offset,
            [DLT_HEADERS.group]: this.groupId,
            [DLT_HEADERS.reason]: outcome.reason,
          },
        },
      ],
    });
  }

  private deadLetterProducer(): Promise<KafkaJS.Producer> {
    this.deadLetters ??= (async () => {
      const producer = this.kafka.producer({
        kafkaJS: { idempotent: true, acks: -1 },
      });
      await producer.connect();
      return producer;
    })();
    // Se a conexão falhar, a próxima mensagem tenta de novo.
    void this.deadLetters.catch(() => {
      this.deadLetters = undefined;
    });
    return this.deadLetters;
  }
}

import { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { Model } from 'mongoose';
import { newId } from '../common/ids/id.js';
import type { Env } from '../config/env.js';
import { KAFKA } from '../kafka/kafka.module.js';
import {
  contextFrom,
  traceHeaders,
  tracer,
} from '../telemetry/trace-context.js';
import { OutboxMetrics } from './outbox.metrics.js';
import { OutboxLease, OutboxMessage } from './outbox.schema.js';
import {
  planPublication,
  type PublicationPlan,
  streamOf,
} from './publication-plan.js';

const LEASE_ID = 'outbox-relay';
/**
 * Validade do lease. O dono o renova a cada rodada; se a instância parar (ou
 * travar), outra assume depois deste prazo.
 */
const LEASE_TTL_MS = 10_000;
/** Mensagens pendentes lidas por rodada. */
const BATCH_SIZE = 100;
/**
 * Prazo de uma transação aberta no Kafka. Se o relay cair no meio de um lote,
 * a transação é abortada pelo próximo dono (ao conectar) ou por este prazo.
 */
const TRANSACTION_TIMEOUT_MS = 30_000;

type Pending = OutboxMessage;

/**
 * Relay do outbox: lê as mensagens pendentes no MongoDB, publica no Kafka e as
 * marca como publicadas (ADR 29).
 *
 * **Uma instância por vez.** Só o dono do lease (`outbox_leases`) publica. O
 * lease é tomado e renovado com um `findOneAndUpdate` atômico, com a hora do
 * próprio MongoDB.
 *
 * **Ordem por show.** Dentro de uma chave, as mensagens saem em ordem de
 * versão, e uma versão menor que a última publicada nunca sai
 * (`planPublication`).
 *
 * **Sem instância zumbi.** Um lease sozinho não basta: a instância que travou
 * (GC, rede) pode acordar depois de outra assumir e publicar um lote velho
 * por cima de um novo. Por isso o produtor é transacional, com o mesmo
 * `transactional.id` em todas as instâncias: quando o novo dono conecta, o
 * broker aborta a transação aberta do anterior e recusa tudo o que ele tentar
 * publicar depois (fencing). Cada lote é uma transação: sai inteiro ou não
 * sai.
 *
 * **Pelo menos uma vez.** Se o processo cair entre publicar e marcar, o lote
 * sai de novo, na mesma ordem. O consumidor guarda a versão mais alta de cada
 * show e ignora a repetição.
 */
@Injectable()
export class OutboxRelay
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  /** Identifica esta instância no lease. */
  readonly instanceId = newId();
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly transactionalId: string;
  private producer?: KafkaJS.Producer;
  /** Produtor ainda conectando; parar o serviço interrompe a conexão. */
  private connecting?: KafkaJS.Producer;
  private timer?: NodeJS.Timeout;
  private ticking?: Promise<void>;
  private stopped = false;
  private leader = false;
  /** Termo do lease em que o produtor atual foi criado. */
  private term?: number;

  constructor(
    @InjectModel(OutboxMessage.name)
    private readonly messages: Model<OutboxMessage>,
    @InjectModel(OutboxLease.name)
    private readonly leases: Model<OutboxLease>,
    @Inject(KAFKA) private readonly kafka: KafkaJS.Kafka,
    private readonly metrics: OutboxMetrics,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
    this.transactionalId = config.get('OUTBOX_TRANSACTIONAL_ID', {
      infer: true,
    });
  }

  onApplicationBootstrap(): void {
    if (this.enabled) {
      this.schedule(0);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    // Com o Kafka fora, a conexão tenta por mais de um minuto; fechar o
    // produtor interrompe a tentativa e a rodada termina com erro.
    await this.connecting?.disconnect().catch(() => undefined);
    await this.ticking;
    await this.releaseLease();
    await this.dropProducer();
  }

  /**
   * Uma rodada: renova o lease e, se for o dono, publica um lote. Devolve
   * quantas mensagens saíram do outbox (publicadas ou descartadas por serem
   * mais velhas que a última publicada).
   */
  async relayOnce(): Promise<number> {
    if (!(await this.holdLease())) {
      await this.dropProducer();
      return 0;
    }
    const plan = await this.nextBatch();
    const done = [...plan.send, ...plan.skip];
    if (done.length === 0) {
      return 0;
    }
    if (plan.send.length > 0) {
      await this.publish(plan.send);
    }
    await this.markPublished(done);
    return done.length;
  }

  /**
   * Toma ou renova o lease. `true` se esta instância é a dona.
   *
   * Cada troca de dono sobe o `term` do lease. Quando esta instância volta a
   * ser dona num termo novo, descarta o produtor que tinha: outra instância
   * pode tê-lo cercado nesse meio-tempo, e o primeiro lote falharia à toa.
   */
  async holdLease(): Promise<boolean> {
    const mine = { $eq: ['$owner', this.instanceId] };
    // Livre se é desta instância, se venceu ou se ainda não existe.
    const free = {
      $or: [mine, { $not: [{ $gt: ['$expiresAt', '$$NOW'] }] }],
    };
    let lease: { owner?: string; term?: number } | null;
    try {
      lease = (await this.leases.collection.findOneAndUpdate(
        { _id: LEASE_ID } as object,
        [
          {
            $set: {
              owner: { $cond: [free, this.instanceId, '$owner'] },
              expiresAt: {
                $cond: [free, { $add: ['$$NOW', LEASE_TTL_MS] }, '$expiresAt'],
              },
              term: {
                $cond: [
                  { $and: [free, { $not: [mine] }] },
                  { $add: [{ $ifNull: ['$term', 0] }, 1] },
                  '$term',
                ],
              },
            },
          },
        ],
        { upsert: true, returnDocument: 'after' },
      )) as { owner?: string; term?: number } | null;
    } catch (error) {
      // Duas instâncias criando o lease ao mesmo tempo: uma perde no _id.
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }
      lease = null;
    }

    const held = lease?.owner === this.instanceId;
    if (held && lease?.term !== this.term) {
      this.term = lease?.term;
      await this.dropProducer();
    }
    if (held !== this.leader) {
      this.leader = held;
      this.logger.log(
        held
          ? 'Esta instância assumiu o relay do outbox'
          : 'Esta instância deixou o relay do outbox',
      );
    }
    return held;
  }

  /** O próximo lote, já em ordem de publicação. */
  async nextBatch(): Promise<PublicationPlan<Pending>> {
    const head = await this.messages
      .find({ publishedAt: null }, { topic: 1, key: 1 })
      .sort({ createdAt: 1, _id: 1 })
      .limit(BATCH_SIZE)
      .lean();
    if (head.length === 0) {
      return { send: [], skip: [] };
    }

    // Todas as pendentes de cada chave do lote, mesmo além do tamanho do lote:
    // uma versão não pode sair antes de uma anterior da mesma chave.
    const streams = [
      ...new Map(head.map((m) => [streamOf(m), m])).values(),
    ].map(({ topic, key }) => ({ topic, key }));
    const [pending, published] = await Promise.all([
      this.messages.find({ publishedAt: null, $or: streams }).lean(),
      this.messages.aggregate<{
        _id: { topic: string; key: string };
        version: number;
      }>([
        { $match: { publishedAt: { $ne: null }, $or: streams } },
        {
          $group: {
            _id: { topic: '$topic', key: '$key' },
            version: { $max: '$aggregateVersion' },
          },
        },
      ]),
    ]);

    const rank = new Map(streams.map((stream, i) => [streamOf(stream), i]));
    pending.sort((a, b) => rank.get(streamOf(a))! - rank.get(streamOf(b))!);
    return planPublication(
      pending,
      new Map(published.map(({ _id, version }) => [streamOf(_id), version])),
    );
  }

  /**
   * Publica as mensagens numa transação do Kafka, na ordem recebida. Com
   * falha, nada do lote fica visível para quem lê só o que foi confirmado, e
   * o lote volta na próxima rodada.
   */
  async publish(messages: readonly Pending[]): Promise<void> {
    const spans = messages.map((message) => this.startSpan(message));
    try {
      const producer = await this.connectedProducer();
      await producer.transaction();
      try {
        // Mensagens seguidas do mesmo tópico vão juntas, sem mudar a ordem.
        for (let i = 0; i < messages.length;) {
          const topic = messages[i].topic;
          const run: KafkaJS.Message[] = [];
          for (; i < messages.length && messages[i].topic === topic; i++) {
            run.push({
              key: messages[i].key,
              value: messages[i].value,
              headers: spans[i].headers,
            });
          }
          await producer.send({ topic, messages: run });
        }
        await producer.commit();
      } catch (error) {
        await producer.abort().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      for (const { span } of spans) {
        span.recordException(error as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
      new Set(messages.map((m) => m.topic)).forEach((topic) =>
        this.metrics.recordFailure(topic),
      );
      // Cercado por outra instância ou num estado fatal: o próximo lote começa
      // com um produtor novo (ou com nenhum, se o lease foi perdido).
      await this.dropProducer();
      throw error;
    }
    spans.forEach(({ span }) => span.end());
    for (const message of messages) {
      this.metrics.recordPublished(message.topic, message.type);
    }
  }

  private async markPublished(messages: readonly Pending[]): Promise<void> {
    // Se cair no meio, as que ficaram pendentes são descartadas na próxima
    // rodada por serem mais velhas que a última publicada (ou saem de novo,
    // se forem a última).
    await this.messages.updateMany(
      { _id: { $in: messages.map((m) => m._id) }, publishedAt: null },
      { $set: { publishedAt: new Date() } },
    );
  }

  /**
   * Um span de produtor por mensagem, filho do trace de quem fez a mudança.
   * O contexto deste span vai no cabeçalho, e o consumidor continua dele.
   */
  private startSpan(message: Pending): {
    span: Span;
    headers: Record<string, string>;
  } {
    const parent = contextFrom(message.headers ?? {});
    const span = tracer.startSpan(
      `send ${message.topic}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.operation.type': 'send',
          'messaging.operation.name': 'send',
          'messaging.destination.name': message.topic,
          'messaging.kafka.message.key': message.key,
          'messaging.message.id': message._id,
          'lotou.message.type': message.type,
        },
      },
      parent,
    );
    return { span, headers: traceHeaders(trace.setSpan(parent, span)) };
  }

  private async connectedProducer(): Promise<KafkaJS.Producer> {
    if (this.producer) {
      return this.producer;
    }
    // Transacional implica idempotente e acks=all.
    const producer = this.kafka.producer({
      kafkaJS: {
        transactionalId: this.transactionalId,
        idempotent: true,
        acks: -1,
        transactionTimeout: TRANSACTION_TIMEOUT_MS,
      },
    });
    this.connecting = producer;
    try {
      // Inicia as transações: é aqui que o produtor anterior com o mesmo
      // transactional.id é cercado.
      await producer.connect();
    } catch (error) {
      await producer.disconnect().catch(() => undefined);
      throw error;
    } finally {
      this.connecting = undefined;
    }
    this.producer = producer;
    return producer;
  }

  private async dropProducer(): Promise<void> {
    const producer = this.producer;
    this.producer = undefined;
    try {
      await producer?.disconnect();
    } catch (error) {
      this.logger.debug(`Falha ao fechar o produtor: ${String(error)}`);
    }
  }

  /** Solta o lease ao parar, para outra instância assumir sem esperar o prazo. */
  private async releaseLease(): Promise<void> {
    if (!this.leader) {
      return;
    }
    try {
      await this.leases.updateOne(
        { _id: LEASE_ID, owner: this.instanceId },
        { $currentDate: { expiresAt: true } },
      );
    } catch (error) {
      this.logger.debug(`Falha ao soltar o lease: ${String(error)}`);
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.ticking = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let done = 0;
    try {
      done = await this.relayOnce();
    } catch (error) {
      this.logger.warn({
        msg: 'Falha ao publicar o outbox; nova tentativa na próxima rodada',
        error: String(error),
      });
    }
    // Lote cheio: provavelmente há mais, então segue sem esperar.
    this.schedule(done >= BATCH_SIZE ? 0 : this.pollIntervalMs);
  }
}

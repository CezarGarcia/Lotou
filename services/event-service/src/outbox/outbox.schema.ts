import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** Por quanto tempo uma mensagem já publicada fica no outbox. */
export const PUBLISHED_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * Uma mensagem a publicar no Kafka, gravada na mesma transação da mudança que
 * a gerou (ADR 29). O relay a publica e preenche `publishedAt`.
 */
@Schema({ collection: 'outbox', versionKey: false })
export class OutboxMessage {
  /** O `eventId` do envelope. */
  @Prop({ type: String })
  _id: string;

  @Prop({ required: true })
  topic: string;

  /** Chave da mensagem no Kafka: o ID do agregado (aqui, o `showId`). */
  @Prop({ required: true })
  key: string;

  /**
   * Versão do agregado depois da mudança. Dentro de uma chave, o relay
   * publica em ordem crescente e nunca publica uma versão menor que a última
   * já publicada.
   */
  @Prop({ required: true })
  aggregateVersion: number;

  /** Tipo do envelope (`ShowPublished`, `ShowUpdated`), para métricas e logs. */
  @Prop({ required: true })
  type: string;

  /** O envelope em JSON, exatamente como vai para o Kafka. */
  @Prop({ required: true })
  value: string;

  /**
   * `traceparent` (e `tracestate`) da requisição que fez a mudança: o trace
   * continua no relay e atravessa o broker.
   */
  @Prop({ type: Object, default: {} })
  headers: Record<string, string>;

  @Prop({ required: true })
  createdAt: Date;

  @Prop({ type: Date, default: null })
  publishedAt: Date | null;
}

export const OutboxMessageSchema = SchemaFactory.createForClass(OutboxMessage);

// Pendentes, da mais antiga para a mais nova.
OutboxMessageSchema.index({ publishedAt: 1, createdAt: 1, _id: 1 });
// Mensagens de uma chave, por versão: a ordem de publicação e a última versão
// já publicada.
OutboxMessageSchema.index({ topic: 1, key: 1, aggregateVersion: 1 });
// As publicadas saem sozinhas depois de 7 dias; as pendentes (`null`) ficam.
OutboxMessageSchema.index(
  { publishedAt: 1 },
  { expireAfterSeconds: PUBLISHED_RETENTION_SECONDS },
);

/**
 * Quem está com o relay. Só o dono do lease publica; ele renova o lease a
 * cada rodada, e outra instância assume quando o lease vence.
 */
@Schema({ collection: 'outbox_leases', versionKey: false })
export class OutboxLease {
  @Prop({ type: String })
  _id: string;

  /** ID da instância dona do lease. */
  @Prop({ required: true })
  owner: string;

  /** Hora do próprio MongoDB, para não depender do relógio das instâncias. */
  @Prop({ required: true })
  expiresAt: Date;

  /** Sobe a cada troca de dono. */
  @Prop({ required: true, default: 0 })
  term: number;
}

export const OutboxLeaseSchema = SchemaFactory.createForClass(OutboxLease);

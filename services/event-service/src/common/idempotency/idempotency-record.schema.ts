import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Uma `Idempotency-Key` já vista. O `_id` é o hash de (usuário, rota, chave),
 * então o índice único do próprio `_id` decide a corrida entre duas
 * requisições iguais: só uma consegue inserir.
 */
@Schema({ collection: 'idempotency_keys', versionKey: false })
export class IdempotencyRecord {
  @Prop({ type: String })
  _id: string;

  /** Hash do corpo: a mesma chave com outro corpo é erro do cliente. */
  @Prop({ required: true })
  requestHash: string;

  @Prop({ required: true, enum: ['IN_PROGRESS', 'COMPLETED'] })
  status: 'IN_PROGRESS' | 'COMPLETED';

  /** Quando o processamento começou; após o prazo, outra requisição assume. */
  @Prop({ required: true })
  lockedAt: Date;

  /** Corpo da resposta original, em JSON, devolvido igual nas repetições. */
  @Prop({ type: String })
  responseBody?: string;

  @Prop({ type: String })
  responseLocation?: string;

  @Prop({ required: true })
  expiresAt: Date;
}

export const IdempotencyRecordSchema =
  SchemaFactory.createForClass(IdempotencyRecord);

// Índice TTL: o MongoDB apaga o registro quando `expiresAt` passa.
IdempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

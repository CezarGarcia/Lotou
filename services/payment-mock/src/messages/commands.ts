import { z } from 'zod';
import { PoisonMessageError } from '../common/errors.js';

/**
 * Leitura dos comandos de `payment.commands`, conforme os schemas em
 * `contracts/payment.commands/`. A imagem do serviço não leva a pasta
 * `contracts/`; os testes conferem que estes schemas aceitam os exemplos de lá.
 *
 * Campos a mais são ignorados, não recusados: um campo novo e opcional não
 * muda a versão do contrato, e o produtor pode passar a enviá-lo antes de o
 * consumidor saber o que fazer com ele.
 */

/** O mesmo padrão de UUID dos contratos (minúsculo, com hífens). */
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const envelopeSchema = z.object({
  eventId: uuid,
  type: z.string().min(1),
  version: z.number().int().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.unknown(),
});

const authorizePaymentV1 = z.object({
  orderId: uuid,
  buyerId: z.string().min(1),
  amountCents: cents,
});

export const REFUND_REASONS = [
  'RESERVATION_EXPIRED',
  'ORDER_CANCELLED',
] as const;

const refundPaymentV1 = z.object({
  orderId: uuid,
  amountCents: cents,
  reason: z.enum(REFUND_REASONS),
});

interface CommandBase {
  eventId: string;
  occurredAt: string;
}

export interface AuthorizePayment extends CommandBase {
  type: 'AuthorizePayment';
  payload: z.infer<typeof authorizePaymentV1>;
}

export interface RefundPayment extends CommandBase {
  type: 'RefundPayment';
  payload: z.infer<typeof refundPaymentV1>;
}

export type PaymentCommand = AuthorizePayment | RefundPayment;

/** Tipos e versões que este serviço entende. */
const PAYLOAD_SCHEMAS = {
  'AuthorizePayment.v1': authorizePaymentV1,
  'RefundPayment.v1': refundPaymentV1,
} as const;

export type ParsedMessage =
  | { kind: 'command'; command: PaymentCommand }
  /** Tipo ou versão desconhecida: o consumidor ignora (contracts/README.md). */
  | { kind: 'unknown'; eventId: string; type: string; version: number };

/**
 * Lê o valor de uma mensagem. Lança `PoisonMessageError` se ela não é JSON,
 * não tem o envelope ou, sendo de um tipo conhecido, tem o payload fora do
 * contrato.
 */
export function parseMessage(value: Buffer | string | null): ParsedMessage {
  if (value === null || value.length === 0) {
    throw new PoisonMessageError('Mensagem sem valor');
  }
  let json: unknown;
  try {
    json = JSON.parse(value.toString());
  } catch (error) {
    throw new PoisonMessageError('Mensagem não é JSON', { cause: error });
  }

  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    throw new PoisonMessageError(
      `Envelope inválido: ${z.prettifyError(envelope.error)}`,
    );
  }
  const { eventId, type, version, occurredAt, payload } = envelope.data;

  const key = `${type}.v${version}`;
  if (!Object.hasOwn(PAYLOAD_SCHEMAS, key)) {
    return { kind: 'unknown', eventId, type, version };
  }
  const schema = PAYLOAD_SCHEMAS[key as keyof typeof PAYLOAD_SCHEMAS];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PoisonMessageError(
      `Payload de ${key} inválido: ${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    kind: 'command',
    command: {
      eventId,
      occurredAt,
      type,
      payload: parsed.data,
    } as PaymentCommand,
  };
}

import { z } from 'zod';
import { PoisonMessageError } from '../common/errors.js';
import { TOPICS } from '../kafka/topics.js';

/**
 * Leitura das mensagens consumidas, conforme os schemas em
 * `contracts/order.events/` e `contracts/shows.catalog/`. A imagem do serviço
 * não leva a pasta `contracts/`; os testes conferem que estes schemas aceitam
 * os exemplos de lá.
 *
 * Só o que a portaria usa é lido: campos a mais são ignorados, não recusados.
 * Um campo novo e opcional não muda a versão do contrato, e o catálogo leva
 * lotes e setores que aqui não interessam.
 */

/** O mesmo padrão de UUID dos contratos (minúsculo, com hífens). */
const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const instant = z.iso.datetime({ offset: true });

/** Fuso IANA que o `Intl` do Node conhece (a regra da abertura dos portões usa). */
const timeZone = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Fuso horário desconhecido');

const envelopeSchema = z.object({
  eventId: uuid,
  type: z.string().min(1),
  version: z.number().int().min(1),
  occurredAt: instant,
  payload: z.unknown(),
});

const ticketsIssuedV1 = z.object({
  orderId: uuid,
  showId: uuid,
  tickets: z
    .array(
      z.object({
        ticketId: uuid,
        sectorId: uuid,
        sectorName: z.string().min(1),
        seat: z.string().nullable(),
      }),
    )
    .min(1),
  issuedAt: instant,
});

export const CANCEL_REASONS = ['ORDER_CANCELLED', 'SHOW_CANCELLED'] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

const ticketsCancelledV1 = z.object({
  orderId: uuid,
  showId: uuid,
  ticketIds: z.array(uuid).min(1),
  reason: z.enum(CANCEL_REASONS),
  cancelledAt: instant,
});

/** `ShowPublished` e `ShowUpdated` têm o mesmo payload: o show inteiro. */
const catalogShowV1 = z.object({
  showId: uuid,
  version: z.number().int().min(1),
  producerId: z.string().min(1),
  status: z.string().min(1),
  title: z.string().min(1),
  artist: z.string().min(1),
  startsAt: instant,
  doorsOpenAt: instant.nullable(),
  venue: z.object({
    name: z.string().min(1),
    timezone: timeZone,
  }),
});

interface MessageBase {
  eventId: string;
  occurredAt: string;
}

export interface TicketsIssued extends MessageBase {
  type: 'TicketsIssued';
  payload: z.infer<typeof ticketsIssuedV1>;
}

export interface TicketsCancelled extends MessageBase {
  type: 'TicketsCancelled';
  payload: z.infer<typeof ticketsCancelledV1>;
}

export interface CatalogShow extends MessageBase {
  type: 'ShowPublished' | 'ShowUpdated';
  payload: z.infer<typeof catalogShowV1>;
}

export type KnownMessage = TicketsIssued | TicketsCancelled | CatalogShow;

/** Tipos e versões que este serviço entende, por tópico. */
const PAYLOAD_SCHEMAS: Record<string, Record<string, z.ZodType>> = {
  [TOPICS.orderEvents]: {
    'TicketsIssued.v1': ticketsIssuedV1,
    'TicketsCancelled.v1': ticketsCancelledV1,
  },
  [TOPICS.catalog]: {
    'ShowPublished.v1': catalogShowV1,
    'ShowUpdated.v1': catalogShowV1,
  },
};

export type ParsedMessage =
  | { kind: 'known'; message: KnownMessage }
  /**
   * Tipo ou versão que a portaria não usa (`OrderConfirmed`, por exemplo): o
   * consumidor ignora, sem olhar o payload (contracts/README.md).
   */
  | { kind: 'ignored'; eventId: string; type: string; version: number };

/**
 * Lê o valor de uma mensagem do tópico. Lança `PoisonMessageError` se ela não
 * é JSON, não tem o envelope ou, sendo de um tipo usado aqui, tem o payload
 * fora do contrato.
 */
export function parseMessage(
  topic: string,
  value: Buffer | string | null,
): ParsedMessage {
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
  const schemas = PAYLOAD_SCHEMAS[topic] ?? {};
  if (!Object.hasOwn(schemas, key)) {
    return { kind: 'ignored', eventId, type, version };
  }
  const parsed = schemas[key].safeParse(payload);
  if (!parsed.success) {
    throw new PoisonMessageError(
      `Payload de ${key} inválido: ${z.prettifyError(parsed.error)}`,
    );
  }
  return {
    kind: 'known',
    message: {
      eventId,
      occurredAt,
      type,
      payload: parsed.data,
    } as KnownMessage,
  };
}

import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';

/**
 * Tipos de `inventory.events` que mudam o que a página do show mostra: o lote
 * em venda e o preço (Fluxo C). Os outros (`ReservationConfirmed`,
 * `ReservationReleased`) e os que ainda não existem são ignorados.
 */
const HANDLED = new Set(['LotSoldOut@1', 'LotOpened@1']);

/** Só o envelope e o que o efeito usa; o contrato completo é do produtor. */
const envelopeSchema = z.looseObject({
  eventId: z.string().min(1),
  type: z.string().min(1),
  version: z.number().int(),
});
const lotEventSchema = envelopeSchema.extend({
  payload: z.looseObject({ showId: z.uuid() }),
});

export interface RetryPolicy {
  attempts: number;
  /** Espera antes da segunda tentativa; dobra a cada nova tentativa. */
  backoffMs: number;
}

/** Três tentativas em 0,6 s: cobre uma oscilação do Redis sem travar a partição. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 3, backoffMs: 200 };

export type InventoryEventOutcome =
  /** Cache do show apagado. */
  | { result: 'processed'; type: string; eventId: string; showId: string }
  /** Tipo (ou versão) que este serviço não trata. */
  | { result: 'ignored'; type: string; eventId: string }
  /** Mensagem inválida, ou o efeito falhou em todas as tentativas: vai para a DLT. */
  | {
      result: 'dead_lettered';
      type?: string;
      eventId?: string;
      reason: string;
    };

/**
 * Trata uma mensagem de `inventory.events`: em `LotSoldOut` e `LotOpened`,
 * apaga o cache da página do show (`invalidate`).
 *
 * Idempotente por natureza: apagar uma chave que já não existe não muda nada,
 * então uma mensagem repetida (entrega pelo menos uma vez) não precisa ser
 * registrada. Uma mensagem malformada vai direto para a DLT; uma falha do
 * efeito é tentada de novo, com espera crescente, antes de ir.
 */
export async function handleInventoryEvent(
  value: Buffer | string | null,
  invalidate: (showId: string) => Promise<void>,
  retry: RetryPolicy = DEFAULT_RETRY,
): Promise<InventoryEventOutcome> {
  let json: unknown;
  try {
    json = JSON.parse(value?.toString() ?? '');
  } catch {
    return { result: 'dead_lettered', reason: 'A mensagem não é JSON' };
  }

  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    return { result: 'dead_lettered', reason: 'Envelope inválido' };
  }
  const { type, version, eventId } = envelope.data;
  if (!HANDLED.has(`${type}@${version}`)) {
    return { result: 'ignored', type, eventId };
  }

  const event = lotEventSchema.safeParse(json);
  if (!event.success) {
    return {
      result: 'dead_lettered',
      type,
      eventId,
      reason: `Payload inválido: ${z.prettifyError(event.error)}`,
    };
  }
  const { showId } = event.data.payload;

  for (let attempt = 1; ; attempt++) {
    try {
      await invalidate(showId);
      return { result: 'processed', type, eventId, showId };
    } catch (error) {
      if (attempt >= retry.attempts) {
        return {
          result: 'dead_lettered',
          type,
          eventId,
          reason: `Falhou ${attempt} vezes: ${String(error)}`,
        };
      }
      await sleep(retry.backoffMs * 2 ** (attempt - 1));
    }
  }
}

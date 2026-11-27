import type { FirstEntry, ScannedTicket } from './checkin-result.js';

/**
 * As leituras feitas sem internet (ADR 38): o leitor validou no aparelho, a
 * pessoa já entrou, e a leitura chega depois, em lote. Aqui não há o que
 * recusar na porta; o servidor registra a entrada ou, se ela não valia,
 * registra o conflito.
 */

/** O que aconteceu com cada leitura offline enviada. */
export const OFFLINE_OUTCOMES = [
  /** Primeira entrada do ingresso: gravada como uma entrada online. */
  'RECORDED',
  /** O ingresso já tinha entrado (online, ou offline por outro aparelho). */
  'DUPLICATE',
  /** A pessoa entrou com um ingresso que não valia (lista velha no aparelho). */
  'CONFLICT',
  /** Leitura que não dá para aceitar: código inválido ou horário impossível. */
  'REJECTED',
] as const;
export type OfflineOutcome = (typeof OFFLINE_OUTCOMES)[number];

export const CONFLICT_KINDS = [
  'DUPLICATE',
  'CANCELLED',
  'UNKNOWN',
  'WRONG_SHOW',
] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

export const OFFLINE_REJECTIONS = ['INVALID_CODE', 'INVALID_TIME'] as const;
export type OfflineRejection = (typeof OFFLINE_REJECTIONS)[number];

/** Uma leitura vinda do aparelho; `id` é gerado lá e torna o envio idempotente. */
export interface OfflineScan {
  id: string;
  code: string;
  scannedAt: Date;
}

/** O resultado de cada leitura, como a API responde. */
export type OfflineScanResult =
  | { id: string; outcome: 'RECORDED' }
  | {
      id: string;
      outcome: 'DUPLICATE';
      /** A entrada que valeu; `null` só se a cópia local a perdeu. */
      firstEntry: { gate: string; checkedInAt: string } | null;
    }
  | {
      id: string;
      outcome: 'CONFLICT';
      kind: Exclude<ConflictKind, 'DUPLICATE'>;
    }
  | { id: string; outcome: 'REJECTED'; reason: OfflineRejection };

/** Uma leitura no futuro além disto é recusada: o relógio do aparelho está errado. */
export const MAX_FUTURE_MS = 5 * 60 * 1000;
/** E uma mais velha que isto também: o show acabou, e a leitura não é deste dia. */
export const MAX_AGE_MS = 48 * 60 * 60 * 1000;

/** O horário da leitura cabe na janela aceita (até 5 min à frente, 48 h atrás)? */
export function isPlausibleScanTime(scannedAt: Date, now: Date): boolean {
  const offset = scannedAt.getTime() - now.getTime();
  return offset <= MAX_FUTURE_MS && offset >= -MAX_AGE_MS;
}

/**
 * A ordem de processamento: pelo horário da leitura, para a primeira entrada
 * vencer quando o mesmo ingresso aparece duas vezes no lote; no empate, pelo
 * ID, para a ordem não depender de como o aparelho montou a lista.
 */
export function inScanOrder<T extends OfflineScan>(scans: readonly T[]): T[] {
  return [...scans].sort(
    (a, b) =>
      a.scannedAt.getTime() - b.scannedAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export type OfflineEvaluation =
  | { result: 'ELIGIBLE' }
  | { result: 'DUPLICATE'; entry: FirstEntry | null }
  | { result: 'CONFLICT'; kind: Exclude<ConflictKind, 'DUPLICATE'> };

/**
 * Confere o ingresso de uma leitura offline com a assinatura válida, na mesma
 * ordem da leitura online: existe, é deste show, não foi cancelado, não foi
 * usado.
 *
 * A abertura dos portões não é conferida: o aparelho já aplicou a regra
 * (`NOT_OPEN`) com o pacote, e a pessoa está lá dentro. A corrida com outra
 * entrada gravada ao mesmo tempo é decidida depois, pela constraint única.
 */
export function evaluateOffline(
  ticket: ScannedTicket | undefined,
  showId: string,
): OfflineEvaluation {
  if (!ticket) {
    return { result: 'CONFLICT', kind: 'UNKNOWN' };
  }
  if (ticket.showId !== showId) {
    return { result: 'CONFLICT', kind: 'WRONG_SHOW' };
  }
  if (ticket.status === 'CANCELLED') {
    return { result: 'CONFLICT', kind: 'CANCELLED' };
  }
  if (ticket.status === 'USED' || ticket.entry) {
    return { result: 'DUPLICATE', entry: ticket.entry };
  }
  return { result: 'ELIGIBLE' };
}

/** O resultado de uma leitura já gravada, como ela foi respondida da primeira vez. */
export interface StoredOfflineScan {
  id: string;
  outcome: OfflineOutcome;
  kind: ConflictKind | null;
  reason: OfflineRejection | null;
  firstEntry: FirstEntry | null;
}

export function toResult(stored: StoredOfflineScan): OfflineScanResult {
  const { id } = stored;
  switch (stored.outcome) {
    case 'RECORDED':
      return { id, outcome: 'RECORDED' };
    case 'DUPLICATE':
      return {
        id,
        outcome: 'DUPLICATE',
        firstEntry: stored.firstEntry
          ? {
              gate: stored.firstEntry.gate,
              checkedInAt: stored.firstEntry.at.toISOString(),
            }
          : null,
      };
    case 'CONFLICT':
      return {
        id,
        outcome: 'CONFLICT',
        kind: stored.kind as Exclude<ConflictKind, 'DUPLICATE'>,
      };
    case 'REJECTED':
      return {
        id,
        outcome: 'REJECTED',
        reason: stored.reason as OfflineRejection,
      };
  }
}

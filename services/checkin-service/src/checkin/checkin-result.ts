import type { RejectionReason } from '../messages/checkin-events.js';
import type { TicketStatus } from '../tickets/ticket-status.js';
import { areDoorsOpen, type ShowSchedule } from './doors.js';

/**
 * Resultado da leitura (contracts/api-fase-6.md). O leitor mostra três cores
 * (docs/projeto.md, "Portaria"): liberado, já utilizado com horário e portão,
 * e inválido ou cancelado.
 */
export type CheckinResult = 'ACCEPTED' | RejectionReason;

export const CHECKIN_RESULTS: readonly CheckinResult[] = [
  'ACCEPTED',
  'ALREADY_USED',
  'INVALID_CODE',
  'UNKNOWN_TICKET',
  'CANCELLED',
  'WRONG_SHOW',
  'NOT_OPEN',
];

export type ResultColor = 'green' | 'yellow' | 'red';

export const RESULT_COLORS: Readonly<Record<CheckinResult, ResultColor>> = {
  ACCEPTED: 'green',
  ALREADY_USED: 'yellow',
  INVALID_CODE: 'red',
  UNKNOWN_TICKET: 'red',
  CANCELLED: 'red',
  WRONG_SHOW: 'red',
  NOT_OPEN: 'red',
};

/** A primeira (e única) entrada do ingresso. */
export interface FirstEntry {
  at: Date;
  gate: string;
}

/** O ingresso lido, da cópia local, com o show dele e a entrada, se houver. */
export interface ScannedTicket {
  ticketId: string;
  orderId: string;
  showId: string;
  sectorId: string;
  sectorName: string;
  seat: string | null;
  status: TicketStatus;
  /** `null` se o show ainda não está na cópia local do catálogo. */
  show: ShowSchedule | null;
  /** A entrada já gravada; `null` se o ingresso não foi usado. */
  entry: FirstEntry | null;
}

export type Evaluation =
  | { result: Exclude<CheckinResult, 'ACCEPTED' | 'INVALID_CODE'> }
  /** Passou em tudo: falta só decidir se este portão é o primeiro. */
  | { result: 'ELIGIBLE' };

/**
 * Confere o ingresso, na ordem: existe, é deste show, não foi cancelado, não
 * foi usado e os portões já abriram. A corrida entre portões (dois leitores
 * com o mesmo QR ao mesmo tempo) é decidida depois, pelo Redis e pela
 * constraint única.
 *
 * Sem o show na cópia local, a regra da abertura não é aplicada: o ingresso é
 * válido, e barrar alguém na porta porque o catálogo atrasou é pior do que
 * deixar entrar um pouco antes da hora.
 */
export function evaluate(
  ticket: ScannedTicket | undefined,
  showId: string,
  now: Date,
): Evaluation {
  if (!ticket) {
    return { result: 'UNKNOWN_TICKET' };
  }
  if (ticket.showId !== showId) {
    return { result: 'WRONG_SHOW' };
  }
  if (ticket.status === 'CANCELLED') {
    return { result: 'CANCELLED' };
  }
  if (ticket.status === 'USED') {
    return { result: 'ALREADY_USED' };
  }
  if (ticket.show && !areDoorsOpen(ticket.show, now)) {
    return { result: 'NOT_OPEN' };
  }
  return { result: 'ELIGIBLE' };
}

/** Corpo da resposta do `POST /v1/checkins`: sempre `200`, com o resultado. */
export interface CheckinResponse {
  result: CheckinResult;
  ticket: { ticketId: string; sectorName: string; seat: string | null } | null;
  firstEntry: { at: string; gate: string } | null;
}

export function toResponse(
  result: CheckinResult,
  ticket?: Pick<ScannedTicket, 'ticketId' | 'sectorName' | 'seat'>,
  firstEntry?: FirstEntry | null,
): CheckinResponse {
  return {
    result,
    ticket: ticket
      ? {
          ticketId: ticket.ticketId,
          sectorName: ticket.sectorName,
          seat: ticket.seat,
        }
      : null,
    firstEntry:
      result === 'ALREADY_USED' && firstEntry
        ? { at: firstEntry.at.toISOString(), gate: firstEntry.gate }
        : null,
  };
}

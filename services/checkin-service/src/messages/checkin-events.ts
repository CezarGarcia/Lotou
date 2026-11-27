import { newId } from '../common/ids.js';

/**
 * Eventos publicados em `checkin.events`, no formato dos schemas em
 * `contracts/checkin.events/`. Os testes validam cada um contra o schema.
 */

/** Envelope comum a toda mensagem (contracts/README.md). */
export interface Envelope<T extends string, P> {
  eventId: string;
  type: T;
  version: 1;
  occurredAt: string;
  payload: P;
}

/** Motivos de uma leitura recusada; todo resultado que não é `ACCEPTED`. */
export const REJECTION_REASONS = [
  'INVALID_CODE',
  'UNKNOWN_TICKET',
  'CANCELLED',
  'ALREADY_USED',
  'WRONG_SHOW',
  'NOT_OPEN',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type TicketCheckedIn = Envelope<
  'TicketCheckedIn',
  {
    ticketId: string;
    showId: string;
    orderId: string;
    sectorId: string;
    sectorName: string;
    seat: string | null;
    gate: string;
    checkedInAt: string;
  }
>;

export type CheckinRejected = Envelope<
  'CheckinRejected',
  {
    showId: string;
    gate: string;
    reason: RejectionReason;
    ticketId: string | null;
    rejectedAt: string;
  }
>;

export type CheckinEvent = TicketCheckedIn | CheckinRejected;

/** `occurredAt` é a hora do fato (a entrada, a recusa), em UTC. */
function envelope<T extends CheckinEvent['type'], P>(
  type: T,
  at: Date,
  payload: P,
  eventId = newId(),
): Envelope<T, P> {
  return {
    eventId,
    type,
    version: 1,
    occurredAt: at.toISOString(),
    payload,
  };
}

export interface CheckedInTicket {
  ticketId: string;
  showId: string;
  orderId: string;
  sectorId: string;
  sectorName: string;
  seat: string | null;
}

export const ticketCheckedIn = (
  ticket: CheckedInTicket,
  gate: string,
  checkedInAt: Date,
): TicketCheckedIn =>
  envelope('TicketCheckedIn', checkedInAt, {
    ticketId: ticket.ticketId,
    showId: ticket.showId,
    orderId: ticket.orderId,
    sectorId: ticket.sectorId,
    sectorName: ticket.sectorName,
    seat: ticket.seat,
    gate,
    checkedInAt: checkedInAt.toISOString(),
  });

export interface Rejection {
  /** ID da recusa: vira o `eventId` do `CheckinRejected` e a chave da linha. */
  id: string;
  showId: string;
  gate: string;
  reason: RejectionReason;
  ticketId: string | null;
  rejectedAt: Date;
}

export const checkinRejected = (rejection: Rejection): CheckinRejected =>
  envelope(
    'CheckinRejected',
    rejection.rejectedAt,
    {
      showId: rejection.showId,
      gate: rejection.gate,
      reason: rejection.reason,
      ticketId: rejection.ticketId,
      rejectedAt: rejection.rejectedAt.toISOString(),
    },
    rejection.id,
  );

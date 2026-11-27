import { randomBytes } from 'node:crypto';
import {
  signLegacyTicketCode,
  signTicketCode,
} from '../../src/checkin/ticket-code.js';
import { newId } from '../../src/common/ids.js';
import { contractExample } from './contracts.js';

/**
 * O QR `LOTOU2` do ingresso, como o order-service o emite, assinado com a
 * chave privada gerada para os testes (setup-env.ts).
 */
export const codeOf = (ticketId: string) =>
  signTicketCode(process.env.TEST_TICKET_PRIVATE_KEY!, ticketId);

/** O QR `LOTOU1` (HMAC) de um ingresso emitido antes do `LOTOU2`. */
export const legacyCodeOf = (ticketId: string) =>
  signLegacyTicketCode(process.env.TICKET_QR_KEY!, ticketId);

const HOUR = 60 * 60 * 1000;

export interface ShowOptions {
  showId?: string;
  version?: number;
  producerId?: string;
  status?: string;
  startsAt?: Date;
  doorsOpenAt?: Date | null;
  timezone?: string;
  type?: 'ShowPublished' | 'ShowUpdated';
}

/**
 * Um show no catálogo, a partir do exemplo de `contracts/examples/`. Por
 * padrão, começa daqui a uma hora e os portões já estão abertos.
 */
export function showMessage(options: ShowOptions = {}) {
  const type = options.type ?? 'ShowPublished';
  const example = contractExample('shows.catalog', type);
  const startsAt = options.startsAt ?? new Date(Date.now() + HOUR);
  const doorsOpenAt =
    options.doorsOpenAt === undefined
      ? new Date(startsAt.getTime() - 3 * HOUR)
      : options.doorsOpenAt;
  return {
    ...example,
    eventId: newId(),
    payload: {
      ...example.payload,
      showId: options.showId ?? newId(),
      version: options.version ?? 1,
      producerId: options.producerId ?? example.payload.producerId,
      status: options.status ?? 'ON_SALE',
      startsAt: startsAt.toISOString(),
      doorsOpenAt: doorsOpenAt?.toISOString() ?? null,
      venue: {
        ...example.payload.venue,
        timezone: options.timezone ?? 'America/Sao_Paulo',
      },
    },
  };
}

export interface IssuedTicket {
  ticketId: string;
  sectorId: string;
  sectorName: string;
  seat: string | null;
  code: string;
}

export interface TicketsIssuedMessage {
  eventId: string;
  type: 'TicketsIssued';
  version: 1;
  occurredAt: string;
  payload: {
    orderId: string;
    buyerId: string;
    showId: string;
    tickets: IssuedTicket[];
    issuedAt: string;
  };
}

/**
 * `TicketsIssued` a partir do exemplo do contrato, com pedido e ingressos
 * novos e QR codes assinados de verdade.
 */
export function ticketsIssued(showId: string, count = 1): TicketsIssuedMessage {
  const example = contractExample<TicketsIssuedMessage>(
    'order.events',
    'TicketsIssued',
  );
  const tickets: IssuedTicket[] = Array.from({ length: count }, (_, index) => {
    const ticketId = newId();
    return {
      ticketId,
      sectorId: example.payload.tickets[0].sectorId,
      sectorName: 'Plateia',
      seat: `A-${index + 1}`,
      code: codeOf(ticketId),
    };
  });
  return {
    ...example,
    eventId: newId(),
    payload: {
      ...example.payload,
      orderId: newId(),
      showId,
      tickets,
      issuedAt: new Date().toISOString(),
    },
  };
}

export function ticketsCancelled(
  issued: TicketsIssuedMessage,
  reason: 'ORDER_CANCELLED' | 'SHOW_CANCELLED' = 'ORDER_CANCELLED',
) {
  const example = contractExample('order.events', 'TicketsCancelled');
  return {
    ...example,
    eventId: newId(),
    payload: {
      ...example.payload,
      orderId: issued.payload.orderId,
      showId: issued.payload.showId,
      ticketIds: issued.payload.tickets.map((t) => t.ticketId),
      reason,
      cancelledAt: new Date().toISOString(),
    },
  };
}

/** Um `traceparent` novo, como o do gateway ao encaminhar a leitura. */
export function newTraceparent(): { traceparent: string; traceId: string } {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return { traceparent: `00-${traceId}-${spanId}-01`, traceId };
}

export const traceIdOf = (traceparent: string) => traceparent.split('-')[1];

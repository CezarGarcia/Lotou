import { Order, Ticket } from '../data/sale.models';
import { Show } from '../data/show.models';

const DAY = 86_400_000;
export const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

export function testShow(id: string, startsAt: string, artist = 'Marina Céu'): Show {
  return {
    id,
    artist,
    title: 'Turnê Horizonte',
    status: 'ON_SALE',
    startsAt,
    salesStartAt: null,
    highDemand: false,
    venue: {
      id: 'v1',
      name: 'Arena Paulista',
      city: 'São Paulo',
      state: 'SP',
      timezone: 'America/Sao_Paulo',
    },
    description: '',
    doorsOpenAt: null,
    salesEndAt: null,
    sectors: [],
  } as unknown as Show;
}

export function testTicket(id: string, status: Ticket['status'] = 'VALID'): Ticket {
  return {
    id,
    status,
    sectorName: 'Pista',
    seat: null,
    issuedAt: '2026-11-01T00:00:00Z',
    code: `LOTOU1.${id}.assinatura`,
  };
}

export function testOrder(
  id: string,
  showId: string,
  tickets: Ticket[],
  status: Order['status'] = 'CONFIRMED',
): Order {
  return {
    id,
    status,
    showId,
    reservationId: 'r-' + id,
    totalCents: 10_000,
    cancelReason: null,
    createdAt: '2026-11-01T00:00:00Z',
    confirmedAt: '2026-11-01T00:00:00Z',
    items: [],
    tickets,
  };
}

import { contractErrors } from '../../test/support/contracts.js';
import {
  type CheckinEvent,
  checkinRejected,
  REJECTION_REASONS,
  ticketCheckedIn,
} from './checkin-events.js';

const ticket = {
  ticketId: '01a21a00-0000-7000-8000-000000000013',
  showId: '01a21a00-0000-7000-8000-000000000001',
  orderId: '01a21a00-0000-7000-8000-000000000010',
  sectorId: '01a21a00-0000-7000-8000-000000000004',
  sectorName: 'Plateia',
  seat: 'A-5',
};
const at = new Date('2026-12-16T22:31:00.250Z');

describe('eventos em checkin.events', () => {
  const events: [string, CheckinEvent][] = [
    ['TicketCheckedIn', ticketCheckedIn(ticket, 'Portão B', at)],
    [
      'TicketCheckedIn na pista',
      ticketCheckedIn({ ...ticket, seat: null }, 'Portão A', at),
    ],
    ...REJECTION_REASONS.map((reason): [string, CheckinEvent] => [
      `CheckinRejected (${reason})`,
      checkinRejected({
        id: '01a21b00-0000-7000-8000-000000000036',
        showId: ticket.showId,
        gate: 'Portão B',
        reason,
        ticketId: reason === 'INVALID_CODE' ? null : ticket.ticketId,
        rejectedAt: at,
      }),
    ]),
  ];

  it.each(events)('%s segue o contrato', (_, event) => {
    expect(contractErrors('checkin.events', event)).toEqual([]);
  });

  it('leva a hora do fato em occurredAt e no payload, em UTC', () => {
    const event = ticketCheckedIn(ticket, 'Portão B', at);
    expect(event.occurredAt).toBe('2026-12-16T22:31:00.250Z');
    expect(event.payload.checkedInAt).toBe('2026-12-16T22:31:00.250Z');
    expect(event.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('a recusa usa o ID dela como eventId: gravada de novo, não sai duas vezes', () => {
    const rejection = {
      id: '01a21b00-0000-7000-8000-000000000036',
      showId: ticket.showId,
      gate: 'Portão B',
      reason: 'ALREADY_USED' as const,
      ticketId: ticket.ticketId,
      rejectedAt: at,
    };
    expect(checkinRejected(rejection).eventId).toBe(rejection.id);
  });
});

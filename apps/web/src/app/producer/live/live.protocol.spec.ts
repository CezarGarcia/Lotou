import { describeActivity } from './activity-text';
import { parseEntry, parseMetrics } from './live.protocol';
import { liveMetrics } from './live.testing';

describe('métricas e feed da fase 6', () => {
  it('lê entradas na portaria e reembolsos quando vêm', () => {
    const metrics = parseMetrics({
      ...liveMetrics(),
      checkedIn: 12,
      checkinsByGate: [{ gate: 'Portão A', count: 12 }],
      ordersRefunded: 2,
    });
    expect(metrics).toMatchObject({
      checkedIn: 12,
      checkinsByGate: [{ gate: 'Portão A', count: 12 }],
      ordersRefunded: 2,
    });
  });

  it('sem os campos novos, as métricas seguem como antes', () => {
    const metrics = parseMetrics(liveMetrics())!;
    expect(metrics.ticketsSold).toBe(1240);
    expect('checkedIn' in metrics).toBe(false);
    expect('checkinsByGate' in metrics).toBe(false);
  });

  it('campo novo fora do formato é descartado sem derrubar as métricas', () => {
    const metrics = parseMetrics({
      ...liveMetrics(),
      checkedIn: -1,
      checkinsByGate: [{ gate: '', count: 1 }],
      ordersRefunded: '3',
    })!;
    expect(metrics.ticketsSold).toBe(1240);
    expect(metrics.checkedIn).toBeUndefined();
    expect(metrics.checkinsByGate).toBeUndefined();
    expect(metrics.ordersRefunded).toBeUndefined();
  });

  it('lê TicketCheckedIn e OrderRefunded', () => {
    const base = { id: '1-0', eventId: 'e', at: '2026-11-26T18:00:00Z' };
    const checkin = parseEntry({
      ...base,
      type: 'TicketCheckedIn',
      sectorName: 'Pista',
      gate: 'B',
    });
    expect(checkin && describeActivity(checkin)).toEqual({
      title: 'Entrada na portaria',
      detail: 'Pista · B',
    });
    const noSector = parseEntry({ ...base, type: 'TicketCheckedIn', gate: 'B' });
    expect(noSector && describeActivity(noSector).detail).toBe('B');
    expect(parseEntry({ ...base, type: 'TicketCheckedIn', sectorName: 'Pista' })).toBeUndefined();

    const refund = parseEntry({
      ...base,
      type: 'OrderRefunded',
      orderId: 'o1',
      refundedCents: 16_500,
      reason: 'SHOW_CANCELLED',
    });
    expect(refund && describeActivity(refund).detail.replace(/\u00a0/g, ' ')).toBe(
      'show cancelado · R$ 165,00',
    );
    expect(parseEntry({ ...base, type: 'OrderRefunded', orderId: 'o1' })).toBeUndefined();
  });
});

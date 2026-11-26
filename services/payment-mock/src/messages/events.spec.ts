import { contractErrors } from '../../test/support/contracts.js';
import {
  DECLINE_REASONS,
  type PaymentEvent,
  paymentAuthorized,
  paymentDeclined,
  paymentRefunded,
  refundFailed,
} from './events.js';

const ref = {
  orderId: '01a21a00-0000-7000-8000-000000000010',
  paymentId: '01a21a00-0000-7000-8000-000000000012',
  amountCents: 32_000,
};
const at = new Date('2026-11-26T18:00:01.250Z');

describe('respostas em payment.events', () => {
  const events: [string, PaymentEvent][] = [
    ['PaymentAuthorized', paymentAuthorized(ref, at)],
    ...DECLINE_REASONS.map((reason): [string, PaymentEvent] => [
      `PaymentDeclined (${reason})`,
      paymentDeclined(ref, reason, at),
    ]),
    ['PaymentRefunded', paymentRefunded(ref, at)],
    [
      'PaymentRefunded de valor 0',
      paymentRefunded({ ...ref, amountCents: 0 }, at),
    ],
    ['RefundFailed', refundFailed(ref, 2, at)],
  ];

  it.each(events)('%s segue o contrato', (_, event) => {
    expect(contractErrors('payment.events', event)).toEqual([]);
  });

  it('leva a hora do fato em occurredAt e no payload, em UTC', () => {
    const event = paymentDeclined(ref, 'CARD_DECLINED', at);
    expect(event.occurredAt).toBe('2026-11-26T18:00:01.250Z');
    expect(event.payload.declinedAt).toBe('2026-11-26T18:00:01.250Z');
  });

  it('dá um eventId UUID v7 novo a cada mensagem, mesmo para o mesmo fato', () => {
    const first = paymentAuthorized(ref, at);
    const second = paymentAuthorized(ref, at);
    expect(first.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(second.eventId).not.toBe(first.eventId);
    expect(second.payload).toEqual(first.payload);
  });
});

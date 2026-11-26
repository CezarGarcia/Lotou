import { contractErrors } from '../../test/support/contracts.js';
import type { AuthorizePayment, RefundPayment } from '../messages/commands.js';
import type { Payment } from './payment.js';
import {
  GatewayDecisionRequired,
  needsAuthorization,
  needsRefund,
  type PaymentPlan,
  planAuthorize,
  planRefund,
} from './payment-plan.js';

const ORDER_ID = '01a21a00-0000-7000-8000-000000000010';
const PAYMENT_ID = '01a21a00-0000-7000-8000-000000000012';
const decidedAt = new Date('2026-11-26T18:00:01Z');
const now = new Date('2026-11-26T18:05:00Z');

const authorize = (amountCents = 32_000): AuthorizePayment => ({
  type: 'AuthorizePayment',
  eventId: '01a21a00-0000-7000-8000-000000000027',
  occurredAt: '2026-11-26T18:00:00Z',
  payload: { orderId: ORDER_ID, buyerId: 'comprador-1', amountCents },
});

const refund = (amountCents = 32_000): RefundPayment => ({
  type: 'RefundPayment',
  eventId: '01a21a00-0000-7000-8000-000000000028',
  occurredAt: '2026-11-26T18:05:00Z',
  payload: { orderId: ORDER_ID, amountCents, reason: 'ORDER_CANCELLED' },
});

const payment = (changes: Partial<Payment> = {}): Payment => ({
  id: PAYMENT_ID,
  orderId: ORDER_ID,
  buyerId: 'comprador-1',
  status: 'AUTHORIZED',
  amountCents: 32_000,
  declineReason: null,
  refundedAmountCents: 0,
  refundAttempts: 0,
  decidedAt,
  refundedAt: null,
  ...changes,
});

/** Toda resposta planejada segue o contrato de payment.events. */
function expectValid(plan: PaymentPlan): PaymentPlan {
  expect(contractErrors('payment.events', plan.event)).toEqual([]);
  return plan;
}

describe('planAuthorize', () => {
  it('sem pagamento, grava a aprovação e responde PaymentAuthorized', () => {
    const plan = expectValid(
      planAuthorize(authorize(), undefined, { approved: true }, now),
    );
    expect(plan.insert).toMatchObject({
      orderId: ORDER_ID,
      buyerId: 'comprador-1',
      status: 'AUTHORIZED',
      amountCents: 32_000,
      decidedAt: now,
    });
    expect(plan.result).toBe('authorized');
    expect(plan.event).toMatchObject({
      type: 'PaymentAuthorized',
      payload: {
        orderId: ORDER_ID,
        paymentId: plan.insert!.id,
        amountCents: 32_000,
        authorizedAt: now.toISOString(),
      },
    });
  });

  it('sem pagamento, grava a recusa com o motivo e responde PaymentDeclined', () => {
    const plan = expectValid(
      planAuthorize(
        authorize(),
        undefined,
        { approved: false, reason: 'INSUFFICIENT_FUNDS' },
        now,
      ),
    );
    expect(plan.insert).toMatchObject({
      status: 'DECLINED',
      declineReason: 'INSUFFICIENT_FUNDS',
    });
    expect(plan.result).toBe('declined');
    expect(plan.event).toMatchObject({
      type: 'PaymentDeclined',
      payload: { reason: 'INSUFFICIENT_FUNDS' },
    });
  });

  it('sem pagamento e sem decisão do gateway, pede para recomeçar', () => {
    expect(() => planAuthorize(authorize(), undefined, undefined, now)).toThrow(
      GatewayDecisionRequired,
    );
  });

  it.each([
    ['aprovado', payment(), 'PaymentAuthorized'],
    [
      'recusado',
      payment({ status: 'DECLINED', declineReason: 'FRAUD_SUSPECTED' }),
      'PaymentDeclined',
    ],
    [
      'estornado',
      payment({
        status: 'REFUNDED',
        refundedAmountCents: 32_000,
        refundedAt: now,
      }),
      'PaymentAuthorized',
    ],
  ])(
    'com pagamento %s, repete a decisão gravada, sem cobrar de novo',
    (_, current, type) => {
      const plan = expectValid(
        planAuthorize(
          authorize(),
          current,
          { approved: false, reason: 'CARD_DECLINED' },
          now,
        ),
      );
      expect(plan.insert).toBeUndefined();
      expect(plan.update).toBeUndefined();
      expect(plan.result).toBeUndefined();
      expect(plan.event.type).toBe(type);
      expect(plan.event.payload.paymentId).toBe(PAYMENT_ID);
      expect(plan.event.occurredAt).toBe(decidedAt.toISOString());
    },
  );

  it('repete a recusa com o mesmo motivo', () => {
    const plan = planAuthorize(
      authorize(),
      payment({ status: 'DECLINED', declineReason: 'FRAUD_SUSPECTED' }),
      undefined,
      now,
    );
    expect(plan.event.payload).toMatchObject({ reason: 'FRAUD_SUSPECTED' });
  });

  it('com valor diferente do gravado, responde o gravado e avisa', () => {
    const plan = planAuthorize(authorize(99_999), payment(), undefined, now);
    expect(plan.event.payload.amountCents).toBe(32_000);
    expect(plan.warning).toMatch(/outro valor/);
  });

  it('com o pedido anulado por um estorno anterior, recusa', () => {
    const plan = expectValid(
      planAuthorize(
        authorize(),
        payment({ status: 'VOIDED', buyerId: null, refundedAt: decidedAt }),
        { approved: true },
        now,
      ),
    );
    expect(plan.insert).toBeUndefined();
    expect(plan.event).toMatchObject({
      type: 'PaymentDeclined',
      payload: { paymentId: PAYMENT_ID, reason: 'CARD_DECLINED' },
    });
  });
});

describe('planRefund', () => {
  it('estorna o pagamento aprovado, inteiro', () => {
    const plan = expectValid(
      planRefund(refund(), payment(), { succeeded: true }, now),
    );
    expect(plan.update).toMatchObject({
      status: 'REFUNDED',
      refundedAmountCents: 32_000,
      refundAttempts: 1,
      refundedAt: now,
    });
    expect(plan.result).toBe('refunded');
    expect(plan.event).toMatchObject({
      type: 'PaymentRefunded',
      occurredAt: now.toISOString(),
      payload: { paymentId: PAYMENT_ID, amountCents: 32_000 },
    });
  });

  it('estorno que falha mantém o pagamento aprovado e conta a tentativa', () => {
    const plan = expectValid(
      planRefund(
        refund(),
        payment({ refundAttempts: 2 }),
        { succeeded: false },
        now,
      ),
    );
    expect(plan.update).toMatchObject({
      status: 'AUTHORIZED',
      refundAttempts: 3,
      refundedAt: null,
    });
    expect(plan.result).toBe('refund_failed');
    expect(plan.event).toMatchObject({
      type: 'RefundFailed',
      payload: { attempt: 3, amountCents: 32_000 },
    });
  });

  it('estorna o valor aprovado mesmo que o comando traga outro, e avisa', () => {
    const plan = planRefund(refund(100), payment(), { succeeded: true }, now);
    expect(plan.event.payload.amountCents).toBe(32_000);
    expect(plan.warning).toMatch(/integral/);
  });

  it('pagamento aprovado sem decisão do gateway pede para recomeçar', () => {
    expect(() => planRefund(refund(), payment(), undefined, now)).toThrow(
      GatewayDecisionRequired,
    );
  });

  it('pagamento já estornado responde PaymentRefunded de novo, igual', () => {
    const refundedAt = new Date('2026-11-26T18:02:00Z');
    const plan = expectValid(
      planRefund(
        refund(),
        payment({
          status: 'REFUNDED',
          refundedAmountCents: 32_000,
          refundedAt,
        }),
        { succeeded: false },
        now,
      ),
    );
    expect(plan.update).toBeUndefined();
    expect(plan.result).toBeUndefined();
    expect(plan.event).toMatchObject({
      type: 'PaymentRefunded',
      occurredAt: refundedAt.toISOString(),
      payload: { amountCents: 32_000, refundedAt: refundedAt.toISOString() },
    });
  });

  it('pagamento recusado responde PaymentRefunded de valor 0, sem mudar nada', () => {
    const plan = expectValid(
      planRefund(
        refund(),
        payment({ status: 'DECLINED', declineReason: 'CARD_DECLINED' }),
        undefined,
        now,
      ),
    );
    expect(plan.update).toBeUndefined();
    expect(plan.insert).toBeUndefined();
    expect(plan.result).toBeUndefined();
    expect(plan.event).toMatchObject({
      type: 'PaymentRefunded',
      payload: { paymentId: PAYMENT_ID, amountCents: 0 },
    });
    expect(plan.warning).toMatch(/recusado/);
  });

  it('pedido sem pagamento é anulado e responde PaymentRefunded de valor 0', () => {
    const plan = expectValid(planRefund(refund(), undefined, undefined, now));
    expect(plan.insert).toMatchObject({
      orderId: ORDER_ID,
      buyerId: null,
      status: 'VOIDED',
      amountCents: 32_000,
      refundedAmountCents: 0,
      refundedAt: now,
    });
    expect(plan.result).toBeUndefined();
    expect(plan.event).toMatchObject({
      type: 'PaymentRefunded',
      payload: { paymentId: plan.insert!.id, amountCents: 0 },
    });
  });

  it('pedido anulado responde PaymentRefunded de valor 0 de novo', () => {
    const plan = expectValid(
      planRefund(
        refund(),
        payment({ status: 'VOIDED', buyerId: null, refundedAt: decidedAt }),
        undefined,
        now,
      ),
    );
    expect(plan.insert).toBeUndefined();
    expect(plan.event).toMatchObject({
      type: 'PaymentRefunded',
      occurredAt: decidedAt.toISOString(),
      payload: { amountCents: 0 },
    });
  });
});

describe('quando consultar o gateway', () => {
  it('autoriza só pedido sem pagamento', () => {
    expect(needsAuthorization(undefined)).toBe(true);
    expect(needsAuthorization(payment())).toBe(false);
  });

  it('estorna só pagamento aprovado', () => {
    expect(needsRefund(payment())).toBe(true);
    expect(needsRefund(undefined)).toBe(false);
    expect(needsRefund(payment({ status: 'DECLINED' }))).toBe(false);
    expect(needsRefund(payment({ status: 'REFUNDED' }))).toBe(false);
    expect(needsRefund(payment({ status: 'VOIDED' }))).toBe(false);
  });
});

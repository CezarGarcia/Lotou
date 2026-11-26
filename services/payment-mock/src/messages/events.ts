import { newId } from '../common/ids.js';

/**
 * Respostas publicadas em `payment.events`, no formato dos schemas em
 * `contracts/payment.events/`. Os testes validam cada uma contra o schema.
 */

export const DECLINE_REASONS = [
  'INSUFFICIENT_FUNDS',
  'CARD_DECLINED',
  'FRAUD_SUSPECTED',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Envelope comum a toda mensagem (contracts/README.md). */
export interface Envelope<T extends string, P> {
  eventId: string;
  type: T;
  version: 1;
  occurredAt: string;
  payload: P;
}

interface PaymentRef {
  orderId: string;
  paymentId: string;
  amountCents: number;
}

export type PaymentAuthorized = Envelope<
  'PaymentAuthorized',
  PaymentRef & { authorizedAt: string }
>;
export type PaymentDeclined = Envelope<
  'PaymentDeclined',
  PaymentRef & { reason: DeclineReason; declinedAt: string }
>;
export type PaymentRefunded = Envelope<
  'PaymentRefunded',
  PaymentRef & { refundedAt: string }
>;
export type RefundFailed = Envelope<
  'RefundFailed',
  PaymentRef & { attempt: number; failedAt: string }
>;

export type PaymentEvent =
  PaymentAuthorized | PaymentDeclined | PaymentRefunded | RefundFailed;

/**
 * `occurredAt` é a hora do fato (a aprovação, a recusa, o estorno), não a da
 * mensagem: a mesma resposta publicada de novo descreve o mesmo fato e leva a
 * mesma hora. O `eventId` é sempre novo, porque cada mensagem tem o seu.
 */
function envelope<T extends PaymentEvent['type'], P>(
  type: T,
  at: Date,
  payload: P,
): Envelope<T, P> {
  return {
    eventId: newId(),
    type,
    version: 1,
    occurredAt: at.toISOString(),
    payload,
  };
}

export const paymentAuthorized = (
  ref: PaymentRef,
  authorizedAt: Date,
): PaymentAuthorized =>
  envelope('PaymentAuthorized', authorizedAt, {
    ...ref,
    authorizedAt: authorizedAt.toISOString(),
  });

export const paymentDeclined = (
  ref: PaymentRef,
  reason: DeclineReason,
  declinedAt: Date,
): PaymentDeclined =>
  envelope('PaymentDeclined', declinedAt, {
    ...ref,
    reason,
    declinedAt: declinedAt.toISOString(),
  });

export const paymentRefunded = (
  ref: PaymentRef,
  refundedAt: Date,
): PaymentRefunded =>
  envelope('PaymentRefunded', refundedAt, {
    ...ref,
    refundedAt: refundedAt.toISOString(),
  });

export const refundFailed = (
  ref: PaymentRef,
  attempt: number,
  failedAt: Date,
): RefundFailed =>
  envelope('RefundFailed', failedAt, {
    ...ref,
    attempt,
    failedAt: failedAt.toISOString(),
  });

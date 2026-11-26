import { randomBytes } from 'node:crypto';
import { newId } from '../../src/common/ids.js';
import { contractExample } from './contracts.js';

/**
 * Comandos a partir dos exemplos de `contracts/examples/payment.commands/`,
 * com `eventId` e pedido novos: cada teste tem o seu pedido.
 */
export function authorizeCommand(
  orderId = newId(),
  changes: { amountCents?: number } = {},
) {
  const example = contractExample('payment.commands', 'AuthorizePayment');
  return {
    ...example,
    eventId: newId(),
    payload: { ...example.payload, orderId, ...changes },
  };
}

export function refundCommand(
  orderId: string,
  changes: { amountCents?: number } = {},
) {
  const example = contractExample('payment.commands', 'RefundPayment');
  return {
    ...example,
    eventId: newId(),
    payload: { ...example.payload, orderId, ...changes },
  };
}

/** Um `traceparent` novo, como o do order-service ao publicar o comando. */
export function newTraceparent(): {
  traceparent: string;
  traceId: string;
  spanId: string;
} {
  const traceId = randomBytes(16).toString('hex');
  const spanId = randomBytes(8).toString('hex');
  return { traceparent: `00-${traceId}-${spanId}-01`, traceId, spanId };
}

/** O trace id de um `traceparent`. */
export const traceIdOf = (traceparent: string) => traceparent.split('-')[1];
export const spanIdOf = (traceparent: string) => traceparent.split('-')[2];

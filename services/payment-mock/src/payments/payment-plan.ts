import { newId } from '../common/ids.js';
import type { AuthorizePayment, RefundPayment } from '../messages/commands.js';
import {
  type DeclineReason,
  type PaymentEvent,
  paymentAuthorized,
  paymentDeclined,
  paymentRefunded,
  refundFailed,
} from '../messages/events.js';
import type { Payment } from './payment.js';
import { assertTransition } from './payment-status.js';
import type {
  AuthorizationDecision,
  RefundDecision,
} from './simulated-gateway.js';

/**
 * Regras do payment-mock, sem banco e sem Kafka: dado o comando e o
 * pagamento como está, o que gravar e o que responder. O PaymentsService
 * aplica o plano numa transação.
 */

/** Resultado novo, para a métrica `payments_total{result}`. */
export type PaymentResult =
  'authorized' | 'declined' | 'refunded' | 'refund_failed';

export interface PaymentPlan {
  /** Pagamento novo a inserir. */
  insert?: Payment;
  /** Pagamento existente, com o estado novo. */
  update?: Payment;
  /** A resposta a publicar. */
  event: PaymentEvent;
  /** Presente só quando algo foi decidido agora; ausente numa resposta repetida. */
  result?: PaymentResult;
  /** Situação fora do caminho feliz, para o log. */
  warning?: string;
}

/**
 * O plano depende de uma decisão do gateway que não foi tomada: o pagamento
 * mudou entre a leitura e a transação. Quem chama recomeça do zero.
 */
export class GatewayDecisionRequired extends Error {}

/**
 * Motivo da recusa a um `AuthorizePayment` de pedido já anulado. O contrato
 * não tem um motivo próprio para isso; `CARD_DECLINED` é o mais neutro.
 */
export const VOIDED_DECLINE_REASON: DeclineReason = 'CARD_DECLINED';

const refOf = (payment: Payment, amountCents = payment.amountCents) => ({
  orderId: payment.orderId,
  paymentId: payment.id,
  amountCents,
});

/** Precisa consultar o gateway? Só para cobrar ou estornar de verdade. */
export function needsAuthorization(current: Payment | undefined): boolean {
  return current === undefined;
}

export function needsRefund(current: Payment | undefined): boolean {
  return current?.status === 'AUTHORIZED';
}

/** A resposta a um `AuthorizePayment`, a partir do que está gravado. */
function authorizationAnswer(payment: Payment): PaymentEvent {
  switch (payment.status) {
    case 'AUTHORIZED':
    // O pagamento foi aprovado; o estorno posterior responde a outro comando.
    case 'REFUNDED':
      return paymentAuthorized(refOf(payment), payment.decidedAt);
    case 'DECLINED':
      return paymentDeclined(
        refOf(payment),
        payment.declineReason ?? VOIDED_DECLINE_REASON,
        payment.decidedAt,
      );
    case 'VOIDED':
      return paymentDeclined(
        refOf(payment),
        VOIDED_DECLINE_REASON,
        payment.decidedAt,
      );
  }
}

/**
 * `AuthorizePayment`: sem pagamento, grava a decisão do gateway e responde com
 * ela. Com pagamento, responde de novo o que já foi decidido, sem cobrar outra
 * vez, mesmo que o valor do comando seja outro.
 */
export function planAuthorize(
  command: AuthorizePayment,
  current: Payment | undefined,
  decision: AuthorizationDecision | undefined,
  now: Date,
): PaymentPlan {
  const { orderId, buyerId, amountCents } = command.payload;
  if (current) {
    return {
      event: authorizationAnswer(current),
      warning:
        current.amountCents === amountCents
          ? undefined
          : `AuthorizePayment repetido com outro valor (${amountCents}, gravado ${current.amountCents}); vale o gravado`,
    };
  }
  if (!decision) {
    throw new GatewayDecisionRequired();
  }
  const payment: Payment = {
    id: newId(),
    orderId,
    buyerId,
    status: decision.approved ? 'AUTHORIZED' : 'DECLINED',
    amountCents,
    declineReason: decision.approved ? null : decision.reason,
    refundedAmountCents: 0,
    refundAttempts: 0,
    decidedAt: now,
    refundedAt: null,
  };
  return {
    insert: payment,
    event: authorizationAnswer(payment),
    result: decision.approved ? 'authorized' : 'declined',
  };
}

/**
 * `RefundPayment`. O estorno é sempre integral (docs/projeto.md, "Cancelamento
 * e reembolso"): devolve o valor aprovado, mesmo que o comando traga outro.
 *
 * | Pagamento    | Resposta                                                  |
 * | ------------ | --------------------------------------------------------- |
 * | `AUTHORIZED` | `PaymentRefunded` ou `RefundFailed`, conforme o gateway    |
 * | `REFUNDED`   | `PaymentRefunded` de novo, com o valor e a hora gravados   |
 * | `DECLINED`   | `PaymentRefunded` com valor 0: nada foi cobrado            |
 * | nenhum       | anula o pedido (`VOIDED`) e responde `PaymentRefunded` 0   |
 * | `VOIDED`     | `PaymentRefunded` com valor 0 de novo                      |
 *
 * Responder "estornado, valor 0" a quem não pagou deixa a saga de cancelamento
 * terminar, em vez de esperar uma resposta que nunca viria.
 */
export function planRefund(
  command: RefundPayment,
  current: Payment | undefined,
  decision: RefundDecision | undefined,
  now: Date,
): PaymentPlan {
  const { orderId, amountCents } = command.payload;

  if (!current) {
    const voided: Payment = {
      id: newId(),
      orderId,
      buyerId: null,
      status: 'VOIDED',
      amountCents,
      declineReason: null,
      refundedAmountCents: 0,
      refundAttempts: 0,
      decidedAt: now,
      refundedAt: now,
    };
    return {
      insert: voided,
      event: paymentRefunded(refOf(voided, 0), now),
      warning:
        'RefundPayment de pedido sem pagamento; pedido anulado, nada a estornar',
    };
  }

  switch (current.status) {
    case 'AUTHORIZED': {
      if (!decision) {
        throw new GatewayDecisionRequired();
      }
      const attempt = current.refundAttempts + 1;
      const warning =
        amountCents === current.amountCents
          ? undefined
          : `RefundPayment com valor ${amountCents}, aprovado ${current.amountCents}; o estorno é integral`;
      if (!decision.succeeded) {
        return {
          update: { ...current, refundAttempts: attempt },
          event: refundFailed(refOf(current), attempt, now),
          result: 'refund_failed',
          warning,
        };
      }
      assertTransition(current.status, 'REFUNDED');
      const refunded: Payment = {
        ...current,
        status: 'REFUNDED',
        refundedAmountCents: current.amountCents,
        refundAttempts: attempt,
        refundedAt: now,
      };
      return {
        update: refunded,
        event: paymentRefunded(refOf(refunded), now),
        result: 'refunded',
        warning,
      };
    }
    case 'REFUNDED':
      return {
        event: paymentRefunded(
          refOf(current, current.refundedAmountCents),
          current.refundedAt ?? now,
        ),
      };
    case 'DECLINED':
      return {
        event: paymentRefunded(refOf(current, 0), now),
        warning: 'RefundPayment de pagamento recusado; nada a estornar',
      };
    case 'VOIDED':
      return {
        event: paymentRefunded(refOf(current, 0), current.refundedAt ?? now),
      };
  }
}

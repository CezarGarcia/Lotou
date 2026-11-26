import { NonRetryableError } from '../common/errors.js';

/**
 * Estados do pagamento simulado:
 *
 * - `AUTHORIZED`: aprovado; pode ser estornado;
 * - `DECLINED`: recusado; nada foi cobrado;
 * - `REFUNDED`: aprovado e depois estornado;
 * - `VOIDED`: anulado antes de existir. Chegou um `RefundPayment` de um pedido
 *   sem pagamento; a linha fecha o pedido, para que um `AuthorizePayment`
 *   atrasado não cobre o que já foi cancelado.
 */
export const PAYMENT_STATUSES = [
  'AUTHORIZED',
  'DECLINED',
  'REFUNDED',
  'VOIDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Estados em que um pagamento nasce. */
export const INITIAL_STATUSES: readonly PaymentStatus[] = [
  'AUTHORIZED',
  'DECLINED',
  'VOIDED',
];

/**
 * Tabela única de transições. Toda mudança de estado passa por ela; o que não
 * está aqui é recusado. Um estorno que falha não muda o estado: o pagamento
 * continua `AUTHORIZED` e só conta mais uma tentativa.
 */
export const PAYMENT_TRANSITIONS: Readonly<
  Record<PaymentStatus, readonly PaymentStatus[]>
> = {
  AUTHORIZED: ['REFUNDED'],
  DECLINED: [],
  REFUNDED: [],
  VOIDED: [],
};

export const canTransition = (
  from: PaymentStatus,
  to: PaymentStatus,
): boolean => PAYMENT_TRANSITIONS[from].includes(to);

export class InvalidTransitionError extends NonRetryableError {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`Transição de pagamento fora da tabela: ${from} -> ${to}`);
  }
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

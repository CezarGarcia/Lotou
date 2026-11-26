import type { DeclineReason } from '../messages/events.js';
import type { PaymentStatus } from './payment-status.js';

/** Uma linha de `payments`: o pagamento de um pedido e o que foi decidido. */
export interface Payment {
  /** `paymentId` nas respostas. */
  id: string;
  orderId: string;
  /** Ausente no pagamento anulado (`VOIDED`), que nunca teve comprador. */
  buyerId: string | null;
  status: PaymentStatus;
  amountCents: number;
  /** Só no `DECLINED`. */
  declineReason: DeclineReason | null;
  refundedAmountCents: number;
  /** Estornos tentados, com sucesso ou não. */
  refundAttempts: number;
  /** Quando foi aprovado, recusado ou anulado. */
  decidedAt: Date;
  /** Só no `REFUNDED` e no `VOIDED`. */
  refundedAt: Date | null;
}

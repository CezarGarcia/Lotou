import type { Pool, PoolClient } from 'pg';
import type { DeclineReason } from '../messages/events.js';
import type { Payment } from './payment.js';
import type { PaymentStatus } from './payment-status.js';

type Queryable = Pool | PoolClient;

interface PaymentRow {
  id: string;
  order_id: string;
  buyer_id: string | null;
  status: PaymentStatus;
  // `bigint` chega como texto pelo driver, para não perder precisão.
  amount_cents: string;
  decline_reason: DeclineReason | null;
  refunded_amount_cents: string;
  refund_attempts: number;
  decided_at: Date;
  refunded_at: Date | null;
}

/** Centavos cabem com folga num `number`; acima disso, algo está errado. */
function cents(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Valor em centavos fora do intervalo seguro: ${value}`);
  }
  return parsed;
}

const toPayment = (row: PaymentRow): Payment => ({
  id: row.id,
  orderId: row.order_id,
  buyerId: row.buyer_id,
  status: row.status,
  amountCents: cents(row.amount_cents),
  declineReason: row.decline_reason,
  refundedAmountCents: cents(row.refunded_amount_cents),
  refundAttempts: row.refund_attempts,
  decidedAt: row.decided_at,
  refundedAt: row.refunded_at,
});

export async function isProcessed(
  db: Queryable,
  eventId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    'SELECT 1 FROM processed_events WHERE event_id = $1',
    [eventId],
  );
  return rowCount === 1;
}

/**
 * Registra o comando como processado. Devolve `false` se ele já estava: outra
 * transação (outra instância, ou uma entrega repetida) chegou antes. Duas
 * transações com o mesmo `eventId` se enfileiram no índice único, e a segunda
 * só vê o conflito depois que a primeira confirma.
 */
export async function markProcessed(
  db: PoolClient,
  eventId: string,
  type: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO processed_events (event_id, type) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, type],
  );
  return rowCount === 1;
}

/**
 * O pagamento do pedido. Com `lock`, segura a linha até o fim da transação:
 * dois comandos do mesmo pedido nunca decidem ao mesmo tempo.
 */
export async function findByOrder(
  db: Queryable,
  orderId: string,
  { lock = false } = {},
): Promise<Payment | undefined> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT id, order_id, buyer_id, status, amount_cents, decline_reason,
            refunded_amount_cents, refund_attempts, decided_at, refunded_at
       FROM payments WHERE order_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [orderId],
  );
  return rows[0] && toPayment(rows[0]);
}

/**
 * Insere o pagamento. Devolve `false` se o pedido já tinha um, gravado por uma
 * transação concorrente depois da leitura.
 */
export async function insertPayment(
  db: PoolClient,
  payment: Payment,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO payments (id, order_id, buyer_id, status, amount_cents,
                           decline_reason, refunded_amount_cents,
                           refund_attempts, decided_at, refunded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (order_id) DO NOTHING`,
    [
      payment.id,
      payment.orderId,
      payment.buyerId,
      payment.status,
      payment.amountCents,
      payment.declineReason,
      payment.refundedAmountCents,
      payment.refundAttempts,
      payment.decidedAt,
      payment.refundedAt,
    ],
  );
  return rowCount === 1;
}

/** Grava o estado novo de um pagamento já travado com `findByOrder(lock)`. */
export async function updatePayment(
  db: PoolClient,
  payment: Payment,
): Promise<void> {
  await db.query(
    `UPDATE payments
        SET status = $2, refunded_amount_cents = $3, refund_attempts = $4,
            refunded_at = $5, updated_at = now()
      WHERE id = $1`,
    [
      payment.id,
      payment.status,
      payment.refundedAmountCents,
      payment.refundAttempts,
      payment.refundedAt,
    ],
  );
}

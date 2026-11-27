package br.com.lotou.order.refund;

import java.time.Instant;
import java.util.UUID;

/**
 * O reembolso de um pedido e o passo em que está (tabela {@code refunds}).
 *
 * <ul>
 *   <li>QUEUED: show cancelado, esperando a vez (controle de vazão);
 *   <li>REFUNDING: {@code RefundPayment} enviado, esperando {@code PaymentRefunded};
 *   <li>COMPLETED: estornado; FAILED: falhou vezes demais, tratamento manual.
 * </ul>
 */
public record Refund(UUID orderId, Reason reason, Status status, long amountCents, int failures, Instant deadline,
        Instant requestedAt) {

    public enum Reason {
        ORDER_CANCELLED, SHOW_CANCELLED
    }

    public enum Status {
        QUEUED, REFUNDING, COMPLETED, FAILED;

        /** A tabela de transições do reembolso. */
        boolean canTransitionTo(Status target) {
            return switch (this) {
                case QUEUED -> target == REFUNDING;
                case REFUNDING -> target == COMPLETED || target == FAILED;
                case FAILED -> target == REFUNDING;
                case COMPLETED -> false;
            };
        }
    }
}

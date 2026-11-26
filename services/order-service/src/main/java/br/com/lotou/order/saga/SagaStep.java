package br.com.lotou.order.saga;

import java.util.EnumSet;
import java.util.Set;

/**
 * Passos da saga de compra e a tabela única de transições entre eles. Cada passo em andamento
 * corresponde a um comando enviado e a uma resposta esperada.
 *
 * <pre>
 * AUTHORIZING_PAYMENT ── aprovado ──> CONFIRMING_RESERVATION ── confirmada ──> COMPLETED
 *        │                                   │
 *        │ recusado                          │ reserva expirou / conflito de cadeira
 *        v                                   v
 * RELEASING_RESERVATION ── liberada ──> COMPENSATED <── estornado ── REFUNDING_PAYMENT
 * </pre>
 *
 * <p>Se a reserva expira enquanto o pagamento é autorizado, a saga vai de AUTHORIZING_PAYMENT
 * direto para REFUNDING_PAYMENT (aprovado) ou COMPENSATED (recusado).
 */
public enum SagaStep {
    /** {@code AuthorizePayment} enviado; espera PaymentAuthorized ou PaymentDeclined. */
    AUTHORIZING_PAYMENT,
    /** {@code ConfirmReservation} enviado; espera ReservationConfirmed. */
    CONFIRMING_RESERVATION,
    /** {@code ReleaseReservation} enviado; espera ReservationReleased. */
    RELEASING_RESERVATION,
    /** {@code RefundPayment} enviado; espera PaymentRefunded. */
    REFUNDING_PAYMENT,
    /** Pedido confirmado e ingressos emitidos. */
    COMPLETED,
    /** Pedido cancelado, com tudo devolvido: ingressos à venda e, se cobrado, o pagamento. */
    COMPENSATED;

    private Set<SagaStep> next() {
        return switch (this) {
            case AUTHORIZING_PAYMENT -> EnumSet.of(CONFIRMING_RESERVATION, RELEASING_RESERVATION, REFUNDING_PAYMENT,
                    COMPENSATED);
            case CONFIRMING_RESERVATION -> EnumSet.of(COMPLETED, REFUNDING_PAYMENT);
            case RELEASING_RESERVATION, REFUNDING_PAYMENT -> EnumSet.of(COMPENSATED);
            case COMPLETED, COMPENSATED -> EnumSet.noneOf(SagaStep.class);
        };
    }

    public boolean canTransitionTo(SagaStep target) {
        return next().contains(target);
    }

    public boolean isFinal() {
        return this == COMPLETED || this == COMPENSATED;
    }
}

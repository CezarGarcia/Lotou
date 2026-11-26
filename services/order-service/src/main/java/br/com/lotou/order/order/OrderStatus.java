package br.com.lotou.order.order;

import java.util.EnumSet;
import java.util.Set;

/**
 * Estados do pedido e a tabela única de transições (seção "Estados" de docs/projeto.md). Toda
 * mudança de estado passa por {@link #canTransitionTo}; o que não está na tabela é recusado.
 */
public enum OrderStatus {
    /** Criado, à espera do pagamento. */
    PENDING,
    /** Pagamento aprovado e ingressos emitidos. */
    CONFIRMED,
    /** Pagamento recusado ou reserva expirada. */
    CANCELLED,
    REFUNDING,
    REFUNDED,
    /** O estorno falhou cinco vezes; pode ser reprocessado. */
    REFUND_FAILED;

    private Set<OrderStatus> next() {
        return switch (this) {
            case PENDING -> EnumSet.of(CONFIRMED, CANCELLED);
            case CONFIRMED -> EnumSet.of(REFUNDING);
            case REFUNDING -> EnumSet.of(REFUNDED, REFUND_FAILED);
            case REFUND_FAILED -> EnumSet.of(REFUNDING);
            case CANCELLED, REFUNDED -> EnumSet.noneOf(OrderStatus.class);
        };
    }

    public boolean canTransitionTo(OrderStatus target) {
        return next().contains(target);
    }
}

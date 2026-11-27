package br.com.lotou.order.refund;

import java.time.Duration;
import java.time.Instant;

import br.com.lotou.order.catalog.LocalShow;
import br.com.lotou.order.order.Order;
import br.com.lotou.order.order.OrderStatus;

/**
 * Quando o comprador pode cancelar um pedido (seção "Cancelamento e reembolso" de docs/projeto.md):
 * pedido confirmado, até 7 dias depois da confirmação, com mais de 48 h para o show e nenhum
 * ingresso usado. Show cancelado pelo produtor sempre pode: o reembolso viria de qualquer jeito.
 */
public final class CancellationPolicy {

    static final Duration WINDOW = Duration.ofDays(7);
    static final Duration BEFORE_SHOW = Duration.ofHours(48);

    /** Por que o pedido não pode ser cancelado. */
    public enum Refusal {
        NOT_CONFIRMED, WINDOW_EXPIRED, TOO_CLOSE_TO_SHOW, TICKET_USED
    }

    /**
     * @param reason por que não pode; {@code null} quando pode
     * @param deadline até quando pode; {@code null} quando não há prazo a mostrar
     */
    public record Decision(boolean allowed, Refusal reason, Instant deadline) {

        static Decision refused(Refusal reason, Instant deadline) {
            return new Decision(false, reason, deadline);
        }
    }

    private CancellationPolicy() {
    }

    /** @param show a cópia local do show; {@code null} se ainda não chegou (só vale a janela de 7 dias) */
    public static Decision decide(Order order, LocalShow show, Instant now) {
        if (!order.is(OrderStatus.CONFIRMED)) {
            return Decision.refused(Refusal.NOT_CONFIRMED, null);
        }
        if (show != null && show.isCancelled()) {
            return new Decision(true, null, null);
        }
        Instant windowEnd = order.getConfirmedAt().plus(WINDOW);
        Instant showLimit = show == null ? null : show.startsAt().minus(BEFORE_SHOW);
        boolean showFirst = showLimit != null && showLimit.isBefore(windowEnd);
        Instant deadline = showFirst ? showLimit : windowEnd;
        if (order.hasUsedTicket()) {
            return Decision.refused(Refusal.TICKET_USED, deadline);
        }
        if (now.isAfter(deadline)) {
            return Decision.refused(showFirst ? Refusal.TOO_CLOSE_TO_SHOW : Refusal.WINDOW_EXPIRED, deadline);
        }
        return new Decision(true, null, deadline);
    }
}

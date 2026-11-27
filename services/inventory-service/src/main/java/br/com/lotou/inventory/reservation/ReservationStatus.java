package br.com.lotou.inventory.reservation;

/**
 * Estados da reserva e a tabela única de transições (seção "Estados" de docs/projeto.md). A reserva
 * segurada vai para um dos três desfechos; a confirmada só sai de CONFIRMED quando o pedido é
 * cancelado e reembolsado (RETURNED). RELEASED, EXPIRED e RETURNED são finais.
 */
public enum ReservationStatus {
    /** Segurando os ingressos, à espera do pagamento. */
    HELD,
    /** Pagamento aprovado: os ingressos estão vendidos. */
    CONFIRMED,
    /** Pagamento recusado: os ingressos voltaram à venda. */
    RELEASED,
    /** O prazo acabou sem pagamento: os ingressos voltaram à venda. */
    EXPIRED,
    /** Pedido cancelado e reembolsado: os ingressos vendidos voltaram à venda ({@code ReturnTickets}). */
    RETURNED;

    public boolean canTransitionTo(ReservationStatus target) {
        return switch (this) {
            case HELD -> target == CONFIRMED || target == RELEASED || target == EXPIRED;
            case CONFIRMED -> target == RETURNED;
            case RELEASED, EXPIRED, RETURNED -> false;
        };
    }
}

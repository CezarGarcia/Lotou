package br.com.lotou.inventory.reservation;

/**
 * Estados da reserva e a tabela única de transições (seção "Estados" de docs/projeto.md). Só uma
 * reserva segurada muda de estado; os outros três são finais.
 */
public enum ReservationStatus {
    /** Segurando os ingressos, à espera do pagamento. */
    HELD,
    /** Pagamento aprovado: os ingressos estão vendidos. */
    CONFIRMED,
    /** Pagamento recusado: os ingressos voltaram à venda. */
    RELEASED,
    /** O prazo acabou sem pagamento: os ingressos voltaram à venda. */
    EXPIRED;

    public boolean canTransitionTo(ReservationStatus target) {
        return this == HELD && target != HELD;
    }
}

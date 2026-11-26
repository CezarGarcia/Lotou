package br.com.lotou.order.order;

/** Estados do ingresso. Um ingresso válido pode ser usado na portaria ou cancelado; os outros dois são finais. */
public enum TicketStatus {
    VALID,
    USED,
    CANCELLED;

    public boolean canTransitionTo(TicketStatus target) {
        return this == VALID && target != VALID;
    }
}

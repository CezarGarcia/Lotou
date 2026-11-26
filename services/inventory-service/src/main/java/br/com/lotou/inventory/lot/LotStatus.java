package br.com.lotou.inventory.lot;

import java.util.EnumSet;
import java.util.Set;

/**
 * Estados do lote e a tabela única de transições (seção "Estados" de docs/projeto.md). Toda
 * mudança de estado passa por {@link #canTransitionTo}; o que não está na tabela é recusado.
 */
public enum LotStatus {
    /** Ainda não abriu. */
    SCHEDULED,
    ON_SALE,
    /** O contador zerou. */
    SOLD_OUT,
    /** O produtor pausou: não aceita reservas. */
    PAUSED,
    /** As vendas do show encerraram. */
    CLOSED;

    private Set<LotStatus> next() {
        return switch (this) {
            case SCHEDULED -> EnumSet.of(ON_SALE);
            case ON_SALE -> EnumSet.of(SOLD_OUT, PAUSED, CLOSED);
            case PAUSED -> EnumSet.of(ON_SALE, CLOSED);
            // Um ingresso devolvido reabre o último lote quando o setor não tem lote em venda
            // (ADR 25).
            case SOLD_OUT -> EnumSet.of(ON_SALE);
            case CLOSED -> EnumSet.noneOf(LotStatus.class);
        };
    }

    public boolean canTransitionTo(LotStatus target) {
        return next().contains(target);
    }
}

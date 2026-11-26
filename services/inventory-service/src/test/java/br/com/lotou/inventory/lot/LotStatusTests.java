package br.com.lotou.inventory.lot;

import static br.com.lotou.inventory.lot.LotStatus.CLOSED;
import static br.com.lotou.inventory.lot.LotStatus.ON_SALE;
import static br.com.lotou.inventory.lot.LotStatus.PAUSED;
import static br.com.lotou.inventory.lot.LotStatus.SCHEDULED;
import static br.com.lotou.inventory.lot.LotStatus.SOLD_OUT;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

class LotStatusTests {

    /** A tabela de transições do lote, como está em docs/projeto.md. */
    private static final Map<LotStatus, Set<LotStatus>> TABLE = Map.of(
            SCHEDULED, Set.of(ON_SALE),
            ON_SALE, Set.of(SOLD_OUT, PAUSED, CLOSED),
            PAUSED, Set.of(ON_SALE, CLOSED),
            SOLD_OUT, Set.of(ON_SALE),
            CLOSED, Set.of());

    @Test
    void soPermiteAsTransicoesDaTabela() {
        for (LotStatus from : LotStatus.values()) {
            for (LotStatus to : LotStatus.values()) {
                assertThat(from.canTransitionTo(to))
                        .as("%s -> %s", from, to)
                        .isEqualTo(TABLE.get(from).contains(to));
            }
        }
    }
}

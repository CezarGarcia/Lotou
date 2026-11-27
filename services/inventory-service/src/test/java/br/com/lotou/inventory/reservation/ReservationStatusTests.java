package br.com.lotou.inventory.reservation;

import static br.com.lotou.inventory.reservation.ReservationStatus.CONFIRMED;
import static br.com.lotou.inventory.reservation.ReservationStatus.EXPIRED;
import static br.com.lotou.inventory.reservation.ReservationStatus.HELD;
import static br.com.lotou.inventory.reservation.ReservationStatus.RELEASED;
import static br.com.lotou.inventory.reservation.ReservationStatus.RETURNED;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

class ReservationStatusTests {

    /** A tabela de transições da reserva, como está em docs/projeto.md. */
    private static final Map<ReservationStatus, Set<ReservationStatus>> TABLE = Map.of(
            HELD, Set.of(CONFIRMED, RELEASED, EXPIRED),
            CONFIRMED, Set.of(RETURNED),
            RELEASED, Set.of(),
            EXPIRED, Set.of(),
            RETURNED, Set.of());

    @Test
    void soPermiteAsTransicoesDaTabela() {
        for (ReservationStatus from : ReservationStatus.values()) {
            for (ReservationStatus to : ReservationStatus.values()) {
                assertThat(from.canTransitionTo(to))
                        .as("%s -> %s", from, to)
                        .isEqualTo(TABLE.get(from).contains(to));
            }
        }
    }
}

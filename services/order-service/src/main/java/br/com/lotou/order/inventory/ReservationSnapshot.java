package br.com.lotou.order.inventory;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * A reserva como o inventory-service a devolve na API interna. É o contrato de {@code
 * /internal/v1/reservations}.
 */
public record ReservationSnapshot(String buyerId, Reservation reservation) {

    public record Reservation(
            UUID id,
            String status,
            UUID showId,
            UUID sectorId,
            String sectorName,
            int quantity,
            long totalCents,
            Instant expiresAt,
            List<Item> items) {
    }

    /** @param seat rótulo da cadeira; {@code null} na pista */
    public record Item(UUID lotId, String lotName, String seat, long unitPriceCents) {
    }

    public boolean held() {
        return "HELD".equals(this.reservation.status());
    }
}

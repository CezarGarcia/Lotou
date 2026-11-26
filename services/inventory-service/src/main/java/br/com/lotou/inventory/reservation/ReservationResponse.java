package br.com.lotou.inventory.reservation;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** A reserva como a API a devolve. */
public record ReservationResponse(
        UUID id,
        ReservationStatus status,
        UUID showId,
        UUID sectorId,
        String sectorName,
        int quantity,
        long totalCents,
        Instant expiresAt,
        Instant createdAt,
        List<Item> items) {

    /**
     * @param seat rótulo da cadeira; {@code null} na pista
     * @param unitPriceCents preço congelado no momento da reserva, em centavos
     */
    public record Item(UUID lotId, String lotName, String seat, long unitPriceCents) {
    }

    static ReservationResponse of(Reservation reservation, String sectorName) {
        return new ReservationResponse(reservation.getId(), reservation.getStatus(), reservation.getShowId(),
                reservation.getSectorId(), sectorName, reservation.getQuantity(), reservation.getTotalCents(),
                reservation.getExpiresAt(), reservation.getCreatedAt(),
                reservation.getItems().stream()
                        .map(item -> new Item(item.getLotId(), item.getLotName(), item.getSeatLabel(),
                                item.getUnitPriceCents()))
                        .toList());
    }
}

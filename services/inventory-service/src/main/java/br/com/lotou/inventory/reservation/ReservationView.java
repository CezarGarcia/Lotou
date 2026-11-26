package br.com.lotou.inventory.reservation;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Uma reserva, como os dois motores a descrevem. No motor Postgres ela vem da tabela; no motor
 * Redis, do hash {@code res:{id}} enquanto a reserva está ativa, ou da tabela depois.
 */
public record ReservationView(
        UUID id,
        ReservationStatus status,
        UUID showId,
        UUID sectorId,
        String buyerId,
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

    static ReservationView of(Reservation reservation) {
        return new ReservationView(reservation.getId(), reservation.getStatus(), reservation.getShowId(),
                reservation.getSectorId(), reservation.getBuyerId(), reservation.getQuantity(),
                reservation.getTotalCents(), reservation.getExpiresAt(), reservation.getCreatedAt(),
                reservation.getItems().stream()
                        .map(item -> new Item(item.getLotId(), item.getLotName(), item.getSeatLabel(),
                                item.getUnitPriceCents()))
                        .toList());
    }
}

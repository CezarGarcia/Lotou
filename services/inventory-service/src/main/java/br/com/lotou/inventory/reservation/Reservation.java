package br.com.lotou.inventory.reservation;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.lot.Lot;
import br.com.lotou.inventory.seat.Seat;
import br.com.lotou.inventory.shared.UuidV7;
import br.com.lotou.inventory.shared.problem.Problems;
import jakarta.persistence.CascadeType;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Reserva: segura ingressos de um setor por um tempo limitado, enquanto o comprador paga. O preço
 * é o do lote no momento da reserva e fica congelado nos itens, mesmo que o lote vire depois.
 */
@Entity
@Table(name = "reservations")
public class Reservation {

    private static final Logger log = LoggerFactory.getLogger(Reservation.class);

    @Id
    private UUID id;

    private UUID showId;

    private UUID sectorId;

    private String buyerId;

    private String cpfHash;

    @Enumerated(EnumType.STRING)
    private ReservationStatus status;

    private int quantity;

    private long totalCents;

    private Instant expiresAt;

    private String idempotencyKey;

    private String requestHash;

    private Instant createdAt;

    private Instant updatedAt;

    @OneToMany(mappedBy = "reservation", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("position")
    private List<ReservationItem> items = new ArrayList<>();

    protected Reservation() {
    }

    /** Uma reserva nova, segurando {@code quantity} ingressos do lote (e as cadeiras, se houver). */
    static Reservation hold(UUID showId, UUID sectorId, String buyerId, String cpfHash, Lot lot, int quantity,
            List<Seat> seats, Instant now, Instant expiresAt, String idempotencyKey, String requestHash) {
        var reservation = new Reservation();
        reservation.id = UuidV7.generate();
        reservation.showId = showId;
        reservation.sectorId = sectorId;
        reservation.buyerId = buyerId;
        reservation.cpfHash = cpfHash;
        reservation.status = ReservationStatus.HELD;
        reservation.quantity = quantity;
        reservation.totalCents = Math.multiplyExact(lot.getPriceCents(), quantity);
        reservation.expiresAt = expiresAt;
        reservation.idempotencyKey = idempotencyKey;
        reservation.requestHash = requestHash;
        reservation.createdAt = now;
        reservation.updatedAt = now;
        for (int i = 0; i < quantity; i++) {
            Seat seat = seats.isEmpty() ? null : seats.get(i);
            reservation.items.add(new ReservationItem(reservation, i, lot.getId(), lot.getName(),
                    seat == null ? null : seat.getId(), seat == null ? null : seat.getLabel(),
                    lot.getPriceCents()));
        }
        return reservation;
    }

    /** Recusa, e registra em log, a transição que não está na tabela. */
    void transitionTo(ReservationStatus target, Instant now) {
        if (!this.status.canTransitionTo(target)) {
            log.warn("Transição de estado recusada: reserva {} de {} para {}", this.id, this.status, target);
            throw Problems.invalidTransition("Uma reserva", this.status, target);
        }
        this.status = target;
        this.updatedAt = now;
    }

    public boolean is(ReservationStatus status) {
        return this.status == status;
    }

    public boolean expired(Instant now) {
        return !this.expiresAt.isAfter(now);
    }

    public UUID getId() {
        return this.id;
    }

    public UUID getShowId() {
        return this.showId;
    }

    public UUID getSectorId() {
        return this.sectorId;
    }

    public String getBuyerId() {
        return this.buyerId;
    }

    public String getCpfHash() {
        return this.cpfHash;
    }

    public ReservationStatus getStatus() {
        return this.status;
    }

    public int getQuantity() {
        return this.quantity;
    }

    public long getTotalCents() {
        return this.totalCents;
    }

    public Instant getExpiresAt() {
        return this.expiresAt;
    }

    public String getRequestHash() {
        return this.requestHash;
    }

    public Instant getCreatedAt() {
        return this.createdAt;
    }

    public List<ReservationItem> getItems() {
        return this.items;
    }
}

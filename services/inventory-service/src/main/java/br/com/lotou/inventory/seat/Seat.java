package br.com.lotou.inventory.seat;

import java.util.UUID;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/** Uma cadeira numerada de um show: um item único, que só uma reserva pode segurar. */
@Entity
@Table(name = "seats")
public class Seat {

    @Id
    private UUID id;

    private UUID showId;

    private UUID sectorId;

    /** Fileira e número, ex.: {@code A-12}. */
    private String label;

    private int position;

    @Enumerated(EnumType.STRING)
    private SeatStatus status;

    private UUID reservationId;

    protected Seat() {
    }

    public boolean isAvailable() {
        return this.status == SeatStatus.AVAILABLE;
    }

    public void hold(UUID reservationId) {
        this.status = SeatStatus.HELD;
        this.reservationId = reservationId;
    }

    public void sell() {
        this.status = SeatStatus.SOLD;
    }

    public void release() {
        this.status = SeatStatus.AVAILABLE;
        this.reservationId = null;
    }

    public UUID getId() {
        return this.id;
    }

    public int getPosition() {
        return this.position;
    }

    public String getLabel() {
        return this.label;
    }

    public SeatStatus getStatus() {
        return this.status;
    }
}

package br.com.lotou.inventory.reservation;

import java.util.UUID;

import br.com.lotou.inventory.shared.UuidV7;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/** Um ingresso da reserva, com o preço congelado no momento em que foi reservado. */
@Entity
@Table(name = "reservation_items")
public class ReservationItem {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "reservation_id")
    private Reservation reservation;

    private int position;

    private UUID lotId;

    private String lotName;

    private UUID seatId;

    private String seatLabel;

    private long unitPriceCents;

    protected ReservationItem() {
    }

    ReservationItem(Reservation reservation, int position, UUID lotId, String lotName, UUID seatId,
            String seatLabel, long unitPriceCents) {
        this.id = UuidV7.generate();
        this.reservation = reservation;
        this.position = position;
        this.lotId = lotId;
        this.lotName = lotName;
        this.seatId = seatId;
        this.seatLabel = seatLabel;
        this.unitPriceCents = unitPriceCents;
    }

    public UUID getLotId() {
        return this.lotId;
    }

    public String getLotName() {
        return this.lotName;
    }

    public UUID getSeatId() {
        return this.seatId;
    }

    public String getSeatLabel() {
        return this.seatLabel;
    }

    public long getUnitPriceCents() {
        return this.unitPriceCents;
    }
}

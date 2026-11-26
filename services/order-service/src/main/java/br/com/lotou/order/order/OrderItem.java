package br.com.lotou.order.order;

import java.util.UUID;

import br.com.lotou.order.shared.UuidV7;
import jakarta.persistence.Entity;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/** Um ingresso do pedido, com o preço congelado na reserva. */
@Entity
@Table(name = "order_items")
public class OrderItem {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id")
    private Order order;

    private int position;

    private UUID sectorId;

    private String sectorName;

    private UUID lotId;

    private String lotName;

    private String seatLabel;

    private long unitPriceCents;

    protected OrderItem() {
    }

    OrderItem(Order order, int position, UUID sectorId, String sectorName, UUID lotId, String lotName,
            String seatLabel, long unitPriceCents) {
        this.id = UuidV7.generate();
        this.order = order;
        this.position = position;
        this.sectorId = sectorId;
        this.sectorName = sectorName;
        this.lotId = lotId;
        this.lotName = lotName;
        this.seatLabel = seatLabel;
        this.unitPriceCents = unitPriceCents;
    }

    public int getPosition() {
        return this.position;
    }

    public UUID getSectorId() {
        return this.sectorId;
    }

    public String getSectorName() {
        return this.sectorName;
    }

    public String getLotName() {
        return this.lotName;
    }

    public String getSeatLabel() {
        return this.seatLabel;
    }

    public long getUnitPriceCents() {
        return this.unitPriceCents;
    }
}

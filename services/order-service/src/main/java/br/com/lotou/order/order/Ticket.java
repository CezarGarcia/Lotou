package br.com.lotou.order.order;

import java.time.Instant;
import java.util.UUID;

import br.com.lotou.order.shared.UuidV7;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

/**
 * Ingresso emitido quando o pedido é confirmado. Cada ingresso libera uma única entrada.
 *
 * <p>O QR code assinado entra na fase 4, junto com a geração do PDF.
 */
@Entity
@Table(name = "tickets")
public class Ticket {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "order_id")
    private Order order;

    private int position;

    private UUID showId;

    private UUID sectorId;

    private String sectorName;

    private String seatLabel;

    @Enumerated(EnumType.STRING)
    private TicketStatus status;

    private Instant issuedAt;

    protected Ticket() {
    }

    Ticket(Order order, OrderItem item, Instant issuedAt) {
        this.id = UuidV7.generate();
        this.order = order;
        this.position = item.getPosition();
        this.showId = order.getShowId();
        this.sectorId = item.getSectorId();
        this.sectorName = item.getSectorName();
        this.seatLabel = item.getSeatLabel();
        this.status = TicketStatus.VALID;
        this.issuedAt = issuedAt;
    }

    public UUID getId() {
        return this.id;
    }

    public String getSectorName() {
        return this.sectorName;
    }

    public String getSeatLabel() {
        return this.seatLabel;
    }

    public TicketStatus getStatus() {
        return this.status;
    }

    public Instant getIssuedAt() {
        return this.issuedAt;
    }
}

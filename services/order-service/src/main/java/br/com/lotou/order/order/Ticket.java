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
 * <p>O {@code code} é o conteúdo do QR code, assinado com HMAC ({@link TicketCodes}).
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

    private String code;

    protected Ticket() {
    }

    Ticket(Order order, OrderItem item, Instant issuedAt, TicketCodes codes) {
        this.id = UuidV7.generate();
        this.code = codes.codeFor(this.id);
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

    public UUID getSectorId() {
        return this.sectorId;
    }

    public String getSectorName() {
        return this.sectorName;
    }

    public String getSeatLabel() {
        return this.seatLabel;
    }

    public String getCode() {
        return this.code;
    }

    public TicketStatus getStatus() {
        return this.status;
    }

    public Instant getIssuedAt() {
        return this.issuedAt;
    }
}

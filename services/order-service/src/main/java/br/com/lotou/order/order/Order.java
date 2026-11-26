package br.com.lotou.order.order;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.inventory.ReservationSnapshot;
import br.com.lotou.order.shared.UuidV7;
import br.com.lotou.order.shared.problem.Problems;
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
 * Pedido: os ingressos de uma reserva, de um único show, com o preço congelado no momento da
 * reserva. Nasce PENDING e vira CONFIRMED (com os ingressos emitidos) ou CANCELLED. Quem o leva de
 * um estado ao outro é a saga de compra ({@code saga/PurchaseSaga}).
 */
@Entity
@Table(name = "orders")
public class Order {

    private static final Logger log = LoggerFactory.getLogger(Order.class);

    @Id
    private UUID id;

    private String buyerId;

    private UUID showId;

    private UUID reservationId;

    @Enumerated(EnumType.STRING)
    private OrderStatus status;

    private long totalCents;

    @Enumerated(EnumType.STRING)
    private PaymentStatus paymentStatus;

    @Enumerated(EnumType.STRING)
    private CancelReason cancelReason;

    private String idempotencyKey;

    private Instant createdAt;

    private Instant updatedAt;

    private Instant confirmedAt;

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL, orphanRemoval = true)
    @OrderBy("position")
    private List<OrderItem> items = new ArrayList<>();

    @OneToMany(mappedBy = "order", cascade = CascadeType.ALL)
    @OrderBy("position")
    private List<Ticket> tickets = new ArrayList<>();

    protected Order() {
    }

    /** Um pedido novo a partir da reserva: itens e preços são os dela e não mudam mais. */
    static Order pending(String buyerId, String idempotencyKey, ReservationSnapshot.Reservation reservation,
            Instant now) {
        var order = new Order();
        order.id = UuidV7.generate();
        order.buyerId = buyerId;
        order.showId = reservation.showId();
        order.reservationId = reservation.id();
        order.status = OrderStatus.PENDING;
        order.totalCents = reservation.totalCents();
        order.idempotencyKey = idempotencyKey;
        order.createdAt = now;
        order.updatedAt = now;
        int position = 0;
        for (ReservationSnapshot.Item item : reservation.items()) {
            order.items.add(new OrderItem(order, position++, reservation.sectorId(), reservation.sectorName(),
                    item.lotId(), item.lotName(), item.seat(), item.unitPriceCents()));
        }
        return order;
    }

    public void recordPayment(PaymentStatus result, Instant now) {
        this.paymentStatus = result;
        this.updatedAt = now;
    }

    /** PENDING -> CONFIRMED: o pagamento foi aprovado. Emite um ingresso por item. */
    public void confirm(Instant now) {
        transitionTo(OrderStatus.CONFIRMED, now);
        this.confirmedAt = now;
        this.items.forEach(item -> this.tickets.add(new Ticket(this, item, now)));
    }

    /** PENDING -> CANCELLED: pagamento recusado ou reserva expirada. */
    public void cancel(CancelReason reason, Instant now) {
        transitionTo(OrderStatus.CANCELLED, now);
        this.cancelReason = reason;
    }

    /** Recusa, e registra em log, a transição que não está na tabela. */
    private void transitionTo(OrderStatus target, Instant now) {
        if (!this.status.canTransitionTo(target)) {
            log.warn("Transição de estado recusada: pedido {} de {} para {}", this.id, this.status, target);
            throw Problems.invalidTransition("Um pedido", this.status, target);
        }
        this.status = target;
        this.updatedAt = now;
    }

    public boolean is(OrderStatus status) {
        return this.status == status;
    }

    public UUID getId() {
        return this.id;
    }

    public String getBuyerId() {
        return this.buyerId;
    }

    public UUID getShowId() {
        return this.showId;
    }

    public UUID getReservationId() {
        return this.reservationId;
    }

    public OrderStatus getStatus() {
        return this.status;
    }

    public long getTotalCents() {
        return this.totalCents;
    }

    public PaymentStatus getPaymentStatus() {
        return this.paymentStatus;
    }

    public CancelReason getCancelReason() {
        return this.cancelReason;
    }

    public Instant getCreatedAt() {
        return this.createdAt;
    }

    public Instant getConfirmedAt() {
        return this.confirmedAt;
    }

    public List<OrderItem> getItems() {
        return this.items;
    }

    public List<Ticket> getTickets() {
        return this.tickets;
    }
}

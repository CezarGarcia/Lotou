package br.com.lotou.order.order;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.inventory.ReservationSnapshot;
import br.com.lotou.order.pricing.Quote;
import br.com.lotou.order.pricing.ServiceFeePayer;
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
 * reserva. Nasce PENDING e vira CONFIRMED (com os ingressos emitidos) ou CANCELLED; quem o leva de
 * um estado ao outro é a saga de compra ({@code saga/PurchaseSaga}). Um pedido confirmado pode ser
 * reembolsado (REFUNDING, depois REFUNDED ou REFUND_FAILED), pela saga de reembolso
 * ({@code refund/RefundService}).
 *
 * <p>Valores em centavos: {@code totalCents} é o que foi cobrado, subtotal − desconto + taxa (se o
 * comprador paga a taxa).
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

    private long subtotalCents;

    private long discountCents;

    private long serviceFeeCents;

    @Enumerated(EnumType.STRING)
    private ServiceFeePayer serviceFeePaidBy;

    private UUID couponId;

    private String couponCode;

    private Long refundedCents;

    private Instant refundedAt;

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

    /**
     * Um pedido novo a partir da reserva: itens e preços são os dela e não mudam mais. Os valores
     * vêm da cotação, feita com a taxa do show e o cupom, se houver.
     */
    static Order pending(String buyerId, String idempotencyKey, ReservationSnapshot.Reservation reservation,
            Quote quote, UUID couponId, String couponCode, Instant now) {
        var order = new Order();
        order.id = UuidV7.generate();
        order.buyerId = buyerId;
        order.showId = reservation.showId();
        order.reservationId = reservation.id();
        order.status = OrderStatus.PENDING;
        order.subtotalCents = quote.subtotalCents();
        order.discountCents = quote.discountCents();
        order.serviceFeeCents = quote.serviceFeeCents();
        order.serviceFeePaidBy = quote.serviceFeePaidBy();
        order.totalCents = quote.totalCents();
        order.couponId = couponId;
        order.couponCode = couponCode;
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
    public void confirm(Instant now, TicketCodes codes) {
        transitionTo(OrderStatus.CONFIRMED, now);
        this.confirmedAt = now;
        this.items.forEach(item -> this.tickets.add(new Ticket(this, item, now, codes)));
    }

    /** PENDING -> CANCELLED: pagamento recusado ou reserva expirada. */
    public void cancel(CancelReason reason, Instant now) {
        transitionTo(OrderStatus.CANCELLED, now);
        this.cancelReason = reason;
    }

    /**
     * CONFIRMED (ou REFUND_FAILED, de novo) -> REFUNDING: cancela os ingressos ainda válidos e
     * devolve os que cancelou. Um ingresso já usado impede o cancelamento pelo comprador, mas não
     * o reembolso de um show cancelado: ele fica como está.
     */
    public List<UUID> startRefund(Instant now) {
        transitionTo(OrderStatus.REFUNDING, now);
        List<UUID> cancelled = new ArrayList<>();
        for (Ticket ticket : this.tickets) {
            if (ticket.cancel()) {
                cancelled.add(ticket.getId());
            }
        }
        return cancelled;
    }

    /** REFUNDING -> REFUNDED: o estorno foi feito, do valor cobrado inteiro (taxa incluída). */
    public void refunded(Instant now) {
        transitionTo(OrderStatus.REFUNDED, now);
        this.refundedCents = this.totalCents;
        this.refundedAt = now;
    }

    /** REFUNDING -> REFUND_FAILED: o estorno falhou vezes demais; fica para tratamento manual. */
    public void refundFailed(Instant now) {
        transitionTo(OrderStatus.REFUND_FAILED, now);
    }

    /** O ingresso passou pela portaria. Devolve se mudou alguma coisa. */
    public boolean checkIn(UUID ticketId, Instant at, String gate, Instant now) {
        for (Ticket ticket : this.tickets) {
            if (ticket.getId().equals(ticketId) && ticket.use(at, gate)) {
                this.updatedAt = now;
                return true;
            }
        }
        return false;
    }

    public boolean hasUsedTicket() {
        return this.tickets.stream().anyMatch(ticket -> ticket.getStatus() == TicketStatus.USED);
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

    public long getSubtotalCents() {
        return this.subtotalCents;
    }

    public long getDiscountCents() {
        return this.discountCents;
    }

    public long getServiceFeeCents() {
        return this.serviceFeeCents;
    }

    public ServiceFeePayer getServiceFeePaidBy() {
        return this.serviceFeePaidBy;
    }

    public UUID getCouponId() {
        return this.couponId;
    }

    public String getCouponCode() {
        return this.couponCode;
    }

    public Long getRefundedCents() {
        return this.refundedCents;
    }

    public Instant getRefundedAt() {
        return this.refundedAt;
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

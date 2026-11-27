package br.com.lotou.order.order;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.pricing.ServiceFeePayer;
import br.com.lotou.order.refund.CancellationPolicy;

/** O pedido como a API o devolve. Valores em centavos. */
public record OrderResponse(
        UUID id,
        OrderStatus status,
        UUID showId,
        UUID reservationId,
        long totalCents,
        long subtotalCents,
        long discountCents,
        long serviceFeeCents,
        ServiceFeePayer serviceFeePaidBy,
        String couponCode,
        Long refundedCents,
        Instant refundedAt,
        Cancellation cancellation,
        CancelReason cancelReason,
        Instant createdAt,
        Instant confirmedAt,
        List<Item> items,
        List<TicketResponse> tickets) {

    /** @param seat rótulo da cadeira; {@code null} na pista */
    public record Item(String sectorName, String lotName, String seat, long unitPriceCents) {
    }

    /**
     * @param code conteúdo do QR code do ingresso, para a loja desenhar o QR
     * @param usedAt quando passou pela portaria; {@code null} se não passou
     */
    public record TicketResponse(UUID id, TicketStatus status, String sectorName, String seat, Instant issuedAt,
            String code, Instant usedAt, String gate) {
    }

    /**
     * Se o comprador pode cancelar o pedido agora.
     *
     * @param reason por que não pode; {@code null} quando pode
     * @param deadline até quando pode
     */
    public record Cancellation(boolean allowed, CancellationPolicy.Refusal reason, Instant deadline) {
    }

    /** O que a listagem "meus pedidos" mostra. */
    public record Summary(UUID id, OrderStatus status, UUID showId, long totalCents, int tickets, Instant createdAt) {

        static Summary of(Order order) {
            return new Summary(order.getId(), order.getStatus(), order.getShowId(), order.getTotalCents(),
                    order.getItems().size(), order.getCreatedAt());
        }
    }

    /** Página de uma listagem paginada por cursor. */
    public record Page(List<Summary> items, String nextCursor) {
    }

    static OrderResponse of(Order order, CancellationPolicy.Decision decision) {
        return new OrderResponse(order.getId(), order.getStatus(), order.getShowId(), order.getReservationId(),
                order.getTotalCents(), order.getSubtotalCents(), order.getDiscountCents(),
                order.getServiceFeeCents(), order.getServiceFeePaidBy(), order.getCouponCode(),
                order.getRefundedCents(), order.getRefundedAt(),
                new Cancellation(decision.allowed(), decision.reason(), decision.deadline()),
                order.getCancelReason(), order.getCreatedAt(), order.getConfirmedAt(),
                order.getItems().stream()
                        .map(item -> new Item(item.getSectorName(), item.getLotName(), item.getSeatLabel(),
                                item.getUnitPriceCents()))
                        .toList(),
                order.getTickets().stream()
                        .map(ticket -> new TicketResponse(ticket.getId(), ticket.getStatus(), ticket.getSectorName(),
                                ticket.getSeatLabel(), ticket.getIssuedAt(), ticket.getCode(), ticket.getUsedAt(),
                                ticket.getGate()))
                        .toList());
    }
}

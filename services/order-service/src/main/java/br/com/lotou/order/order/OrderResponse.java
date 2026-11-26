package br.com.lotou.order.order;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** O pedido como a API o devolve. Valores em centavos. */
public record OrderResponse(
        UUID id,
        OrderStatus status,
        UUID showId,
        UUID reservationId,
        long totalCents,
        CancelReason cancelReason,
        Instant createdAt,
        Instant confirmedAt,
        List<Item> items,
        List<TicketResponse> tickets) {

    /** @param seat rótulo da cadeira; {@code null} na pista */
    public record Item(String sectorName, String lotName, String seat, long unitPriceCents) {
    }

    public record TicketResponse(UUID id, TicketStatus status, String sectorName, String seat, Instant issuedAt) {
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

    static OrderResponse of(Order order) {
        return new OrderResponse(order.getId(), order.getStatus(), order.getShowId(), order.getReservationId(),
                order.getTotalCents(), order.getCancelReason(), order.getCreatedAt(), order.getConfirmedAt(),
                order.getItems().stream()
                        .map(item -> new Item(item.getSectorName(), item.getLotName(), item.getSeatLabel(),
                                item.getUnitPriceCents()))
                        .toList(),
                order.getTickets().stream()
                        .map(ticket -> new TicketResponse(ticket.getId(), ticket.getStatus(), ticket.getSectorName(),
                                ticket.getSeatLabel(), ticket.getIssuedAt()))
                        .toList());
    }
}

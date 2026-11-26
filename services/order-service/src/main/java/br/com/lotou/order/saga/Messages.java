package br.com.lotou.order.saga;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Os payloads das mensagens que a saga de compra publica e consome, como descritos em
 * {@code contracts/}. Os testes de contrato conferem que o que sai daqui passa no JSON Schema.
 */
final class Messages {

    // ------------------------------------------------------------- order.events

    record Item(UUID sectorId, String sectorName, UUID lotId, String lotName, String seat, long unitPriceCents) {
    }

    record OrderCreated(UUID orderId, String buyerId, UUID showId, UUID reservationId, long totalCents,
            List<Item> items, Instant createdAt) {
    }

    record OrderConfirmed(UUID orderId, String buyerId, UUID showId, UUID reservationId, long totalCents,
            List<Item> items, Instant confirmedAt) {
    }

    record OrderCancelled(UUID orderId, String buyerId, UUID showId, UUID reservationId, long totalCents,
            String reason, Instant cancelledAt) {
    }

    record IssuedTicket(UUID ticketId, UUID sectorId, String sectorName, String seat) {
    }

    record TicketsIssued(UUID orderId, String buyerId, UUID showId, List<IssuedTicket> tickets, Instant issuedAt) {
    }

    // ---------------------------------------------------------- payment.commands

    record AuthorizePayment(UUID orderId, String buyerId, long amountCents) {
    }

    record RefundPayment(UUID orderId, long amountCents, String reason) {
    }

    // -------------------------------------------------------- inventory.commands

    record ConfirmReservation(UUID orderId, UUID reservationId) {
    }

    record ReleaseReservation(UUID orderId, UUID reservationId, String reason) {
    }

    // ------------------------------------------------- respostas que a saga lê

    /** PaymentAuthorized, PaymentDeclined, PaymentRefunded e RefundFailed: só o que a saga usa. */
    record PaymentAnswer(UUID orderId) {
    }

    /** ReservationConfirmed e ReservationReleased: só o que a saga usa. */
    record ReservationFact(UUID reservationId, String reason) {
    }

    private Messages() {
    }
}

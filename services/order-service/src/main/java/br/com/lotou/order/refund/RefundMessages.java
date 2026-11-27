package br.com.lotou.order.refund;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.pricing.ServiceFeePayer;

/** Os payloads que a saga de reembolso publica e lê, como descritos em {@code contracts/}. */
final class RefundMessages {

    record TicketsCancelled(UUID orderId, String buyerId, UUID showId, List<UUID> ticketIds, String reason,
            Instant cancelledAt) {
    }

    record OrderRefunded(UUID orderId, String buyerId, UUID showId, UUID reservationId, long refundedCents,
            String reason, Instant refundedAt, long subtotalCents, long discountCents, long serviceFeeCents,
            ServiceFeePayer serviceFeePaidBy, UUID couponId, String couponCode) {
    }

    record OrderRefundFailed(UUID orderId, String buyerId, UUID showId, int attempts, Instant failedAt) {
    }

    record RefundPayment(UUID orderId, long amountCents, String reason) {
    }

    record ReturnTickets(UUID orderId, UUID reservationId, String reason) {
    }

    /** PaymentRefunded e RefundFailed: só o que a saga usa. */
    record PaymentAnswer(UUID orderId) {
    }

    private RefundMessages() {
    }
}

package br.com.lotou.order.catalog;

import java.time.Instant;
import java.util.UUID;

import br.com.lotou.order.pricing.ServiceFeePayer;

/** O que o order-service guarda de cada show, a partir de {@code shows.catalog}. */
public record LocalShow(UUID id, String producerId, String status, String title, Instant startsAt,
        ServiceFeePayer serviceFeePaidBy, int version) {

    public boolean isCancelled() {
        return "CANCELLED".equals(this.status);
    }
}

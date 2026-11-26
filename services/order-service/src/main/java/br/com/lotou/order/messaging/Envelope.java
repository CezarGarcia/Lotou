package br.com.lotou.order.messaging;

import java.time.Instant;
import java.util.UUID;

import tools.jackson.databind.JsonNode;

/**
 * O envelope de toda mensagem no Kafka (contracts/README.md): o {@code eventId} identifica a
 * mensagem, e o {@code payload} é o fato ou o comando.
 */
public record Envelope(UUID eventId, String type, int version, Instant occurredAt, JsonNode payload) {
}

package br.com.lotou.order.support;

import java.time.Instant;
import java.util.UUID;

import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Publica no Kafka dos testes o que os outros serviços publicariam e o order-service lê fora da
 * saga: versões de um show em {@code shows.catalog} (event-service) e entradas na portaria em
 * {@code checkin.events} (checkin-service). Cada mensagem passa no contrato antes de sair.
 */
public final class CatalogFeed {

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private CatalogFeed() {
    }

    /** Uma versão do show, a partir do exemplo do contrato, com o que o order-service usa trocado. */
    public static void show(UUID showId, int version, String producerId, String status, Instant startsAt,
            String serviceFeePaidBy) {
        ObjectNode envelope = (ObjectNode) JSON.readTree(Contracts.example("shows.catalog", "ShowUpdated"));
        envelope.put("eventId", UUID.randomUUID().toString());
        envelope.put("occurredAt", Instant.now().toString());
        ObjectNode payload = (ObjectNode) envelope.get("payload");
        payload.put("showId", showId.toString());
        payload.put("version", version);
        payload.put("producerId", producerId);
        payload.put("status", status);
        payload.put("startsAt", startsAt.toString());
        payload.put("doorsOpenAt", startsAt.minusSeconds(3600).toString());
        payload.put("salesEndAt", startsAt.minusSeconds(7200).toString());
        payload.put("serviceFeePaidBy", serviceFeePaidBy);
        // IDs próprios de setor, lote e local: o inventory de verdade lê o mesmo tópico, e os IDs do
        // exemplo repetidos em vários shows seriam outro show dono do mesmo setor.
        ((ObjectNode) payload.get("venue")).put("id", ids(showId, "venue"));
        payload.get("sectors").forEach(sector -> {
            ((ObjectNode) sector).put("id", ids(showId, "sector-" + sector.get("id").asString()));
            sector.get("lots").forEach(lot -> ((ObjectNode) lot).put("id",
                    ids(showId, "lot-" + lot.get("id").asString())));
        });
        String message = JSON.writeValueAsString(envelope);
        Contracts.assertValid("shows.catalog", "ShowUpdated", message);
        TestKafka.send("shows.catalog", showId.toString(), message);
    }

    /** Um ID estável por show: as várias versões do mesmo show têm os mesmos setores e lotes. */
    private static String ids(UUID showId, String name) {
        return UUID.nameUUIDFromBytes((showId + "/" + name).getBytes(java.nio.charset.StandardCharsets.UTF_8))
                .toString();
    }

    /** O ingresso passou pela portaria. */
    public static void checkedIn(UUID ticketId, UUID showId, UUID orderId, UUID sectorId, String gate, Instant at) {
        ObjectNode envelope = (ObjectNode) JSON.readTree(Contracts.example("checkin.events", "TicketCheckedIn"));
        envelope.put("eventId", UUID.randomUUID().toString());
        envelope.put("occurredAt", at.toString());
        ObjectNode payload = (ObjectNode) envelope.get("payload");
        payload.put("ticketId", ticketId.toString());
        payload.put("showId", showId.toString());
        payload.put("orderId", orderId.toString());
        payload.put("sectorId", sectorId.toString());
        payload.put("gate", gate);
        payload.put("checkedInAt", at.toString());
        String message = JSON.writeValueAsString(envelope);
        Contracts.assertValid("checkin.events", "TicketCheckedIn", message);
        TestKafka.send("checkin.events", ticketId.toString(), message);
    }
}

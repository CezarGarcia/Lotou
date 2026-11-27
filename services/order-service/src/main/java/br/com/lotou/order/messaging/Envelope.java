package br.com.lotou.order.messaging;

import java.time.Instant;
import java.util.UUID;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * O envelope de toda mensagem no Kafka (contracts/README.md): o {@code eventId} identifica a
 * mensagem, e o {@code payload} é o fato ou o comando.
 */
public record Envelope(UUID eventId, String type, int version, Instant occurredAt, JsonNode payload) {

    /** Lê o envelope de um registro; ilegível ou incompleto é {@link MalformedMessageException} (vai à DLT). */
    public static Envelope parse(JsonMapper json, ConsumerRecord<String, String> record) {
        try {
            Envelope message = json.readValue(record.value(), Envelope.class);
            if (message.eventId() == null || message.type() == null || message.payload() == null) {
                throw new MalformedMessageException("Envelope incompleto em " + record.topic());
            }
            return message;
        }
        catch (JacksonException ex) {
            throw new MalformedMessageException("Envelope ilegível em " + record.topic() + ": " + ex.getMessage());
        }
    }
}

package br.com.lotou.order.messaging;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import br.com.lotou.order.shared.UuidV7;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Grava mensagens no outbox, na transação de quem chama: a mensagem só existe se a mudança que a
 * causou for gravada, e vice-versa. O {@link OutboxRelay} publica depois.
 */
@Component
public class Outbox {

    private final JdbcClient jdbc;
    private final JsonMapper json;
    private final Clock clock;

    public Outbox(JdbcClient jdbc, JsonMapper json, Clock clock) {
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
    }

    /**
     * Enfileira uma mensagem. Exige uma transação aberta: fora dela, a mensagem e a mudança não
     * seriam atômicas.
     *
     * @param key chave da mensagem no Kafka: o ID do agregado (pedido ou show)
     * @param payload o fato ou o comando, serializado como o contrato descreve
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public UUID enqueue(String topic, String key, String type, Object payload) {
        UUID eventId = UuidV7.generate();
        Instant now = this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
        ObjectNode envelope = this.json.createObjectNode();
        envelope.put("eventId", eventId.toString());
        envelope.put("type", type);
        envelope.put("version", 1);
        envelope.put("occurredAt", now.toString());
        envelope.set("payload", this.json.valueToTree(payload));
        this.jdbc.sql("""
                INSERT INTO outbox (id, topic, message_key, type, envelope, traceparent, created_at)
                VALUES (:id, :topic, :key, :type, CAST(:envelope AS jsonb), :traceparent, :createdAt)
                """)
                .param("id", eventId)
                .param("topic", topic)
                .param("key", key)
                .param("type", type)
                .param("envelope", this.json.writeValueAsString(envelope))
                .param("traceparent", currentTraceparent())
                .param("createdAt", Timestamp.from(now))
                .update();
        return eventId;
    }

    /** O contexto do trace atual no formato W3C, para o relay continuar o trace ao publicar. */
    private static String currentTraceparent() {
        Map<String, String> carrier = new HashMap<>();
        W3CTraceContextPropagator.getInstance().inject(Context.current(), carrier, Map::put);
        return carrier.get("traceparent");
    }
}

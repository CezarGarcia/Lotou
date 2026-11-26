package br.com.lotou.order.messaging;

import java.sql.Timestamp;
import java.time.Clock;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * As mensagens que os consumidores deste serviço já processaram ({@code processed_events}). O
 * registro entra na mesma transação do efeito: ou os dois ficam gravados, ou nenhum, e uma
 * mensagem entregue de novo pelo Kafka é ignorada.
 */
@Component
public class Inbox {

    private final JdbcClient jdbc;
    private final Clock clock;

    public Inbox(JdbcClient jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** Registra a mensagem; devolve {@code false} se ela já tinha sido processada. */
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean firstTime(String topic, Envelope message) {
        return this.jdbc.sql("""
                INSERT INTO processed_events (event_id, topic, type, processed_at)
                VALUES (:id, :topic, :type, :now)
                ON CONFLICT (event_id) DO NOTHING
                """)
                .param("id", message.eventId())
                .param("topic", topic)
                .param("type", message.type())
                .param("now", Timestamp.from(this.clock.instant()))
                .update() == 1;
    }
}

package br.com.lotou.inventory.messaging;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.propagation.W3CTraceContextPropagator;
import io.opentelemetry.context.Context;
import io.opentelemetry.context.Scope;
import io.opentelemetry.context.propagation.TextMapGetter;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.support.SendResult;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Publica no Kafka o que os triggers do banco gravaram no outbox (V3__outbox_and_events.sql), na
 * ordem em que foi gravado. É o mesmo relay do order-service.
 *
 * <ul>
 *   <li><b>Uma instância por vez:</b> o lote é lido com um advisory lock do Postgres. Com duas
 *       instâncias publicando lotes diferentes, fatos do mesmo show poderiam sair fora de ordem.
 *   <li><b>Ao menos uma vez:</b> a mensagem só é marcada como publicada depois que o Kafka
 *       confirmou. Se o serviço cair entre as duas coisas, ela sai de novo, e o consumidor a
 *       ignora pelo {@code eventId}.
 *   <li><b>Trace contínuo:</b> quando a transação que gerou o fato informou o contexto do trace
 *       ({@code lotou.traceparent}), a mensagem é publicada dentro dele.
 * </ul>
 */
@Component
public class OutboxRelay {

    private static final Logger log = LoggerFactory.getLogger(OutboxRelay.class);
    /** Identifica o lock do relay deste serviço entre os advisory locks do banco. */
    private static final long LOCK_KEY = 0x494E56454E54L; // "INVENT"
    private static final int BATCH = 200;
    private static final Duration SEND_TIMEOUT = Duration.ofSeconds(10);

    private static final TextMapGetter<Map<String, String>> GETTER = new TextMapGetter<>() {
        @Override
        public Iterable<String> keys(Map<String, String> carrier) {
            return carrier.keySet();
        }

        @Override
        public String get(Map<String, String> carrier, String key) {
            return carrier == null ? null : carrier.get(key);
        }
    };

    private record Pending(UUID id, String topic, String key, String type, String envelope, String traceparent) {
    }

    private final JdbcClient jdbc;
    private final KafkaTemplate<String, String> kafka;
    private final TransactionTemplate transaction;
    private final Clock clock;

    public OutboxRelay(JdbcClient jdbc, KafkaTemplate<String, String> kafka, PlatformTransactionManager transactionManager,
            Clock clock) {
        this.jdbc = jdbc;
        this.kafka = kafka;
        this.transaction = new TransactionTemplate(transactionManager);
        this.clock = clock;
        GlobalOpenTelemetry.getMeter("lotou.inventory").gaugeBuilder("outbox_pending").ofLongs()
                .setDescription("Mensagens do outbox ainda não publicadas no Kafka")
                .buildWithCallback(measurement -> measurement.record(pendingCount()));
    }

    @Scheduled(fixedDelayString = "${lotou.inventory.jobs.outbox-interval:100ms}")
    public void publishPending() {
        int published;
        do {
            published = publishBatch();
        }
        while (published == BATCH);
    }

    /** Publica um lote e devolve quantas mensagens saíram. */
    int publishBatch() {
        Integer published = this.transaction.execute(status -> {
            Boolean locked = this.jdbc.sql("SELECT pg_try_advisory_xact_lock(:key)").param("key", LOCK_KEY)
                    .query(Boolean.class).single();
            if (!Boolean.TRUE.equals(locked)) {
                return 0;
            }
            List<Pending> batch = this.jdbc.sql("""
                    SELECT id, topic, message_key, type, envelope::text AS envelope, traceparent
                    FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT :batch
                    """)
                    .param("batch", BATCH)
                    .query((rs, row) -> new Pending(rs.getObject("id", UUID.class), rs.getString("topic"),
                            rs.getString("message_key"), rs.getString("type"), rs.getString("envelope"),
                            rs.getString("traceparent")))
                    .list();
            if (batch.isEmpty()) {
                return 0;
            }
            send(batch);
            this.jdbc.sql("UPDATE outbox SET published_at = :now WHERE id IN (:ids)")
                    .param("now", Timestamp.from(this.clock.instant()))
                    .param("ids", batch.stream().map(Pending::id).toList())
                    .update();
            return batch.size();
        });
        return published == null ? 0 : published;
    }

    private void send(List<Pending> batch) {
        List<CompletableFuture<SendResult<String, String>>> sent = new ArrayList<>(batch.size());
        for (Pending message : batch) {
            Context origin = message.traceparent() == null ? Context.root()
                    : W3CTraceContextPropagator.getInstance().extract(Context.root(),
                            Map.of("traceparent", message.traceparent()), GETTER);
            try (Scope ignored = origin.makeCurrent()) {
                var record = new ProducerRecord<>(message.topic(), message.key(), message.envelope());
                // O tipo também vai no cabeçalho: dá para filtrar no Kafka UI sem abrir a mensagem.
                record.headers().add("type", message.type().getBytes(StandardCharsets.UTF_8));
                sent.add(this.kafka.send(record));
            }
        }
        try {
            CompletableFuture.allOf(sent.toArray(CompletableFuture[]::new))
                    .get(SEND_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        }
        catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Publicação do outbox interrompida", ex);
        }
        catch (Exception ex) {
            // Nada é marcado como publicado: o lote inteiro sai de novo na próxima rodada.
            log.warn("Falha ao publicar o outbox; o lote será repetido: {}", ex.getMessage());
            throw new IllegalStateException("Falha ao publicar o outbox", ex);
        }
    }

    private long pendingCount() {
        try {
            return this.jdbc.sql("SELECT count(*) FROM outbox WHERE published_at IS NULL").query(Long.class).single();
        }
        catch (RuntimeException ex) {
            return -1;
        }
    }
}

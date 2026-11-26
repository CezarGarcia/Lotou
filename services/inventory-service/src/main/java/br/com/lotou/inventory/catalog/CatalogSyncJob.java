package br.com.lotou.inventory.catalog;

import java.sql.Timestamp;
import java.time.Instant;

import br.com.lotou.inventory.config.InventoryProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Lê o catálogo do event-service de tempos em tempos e atualiza a cópia local.
 *
 * <p>É a integração da fase 1, sem broker: o inventory pergunta o que mudou desde a última
 * leitura. Se o event-service estiver fora do ar, a leitura falha e é repetida na próxima rodada,
 * sem perder nada. Na fase 3 isso vira o tópico {@code shows.catalog} no Kafka (ADR 23).
 *
 * <p>Pode rodar em várias instâncias: aplicar um show é idempotente.
 */
@Component
public class CatalogSyncJob {

    private static final Logger log = LoggerFactory.getLogger(CatalogSyncJob.class);

    private final CatalogClient client;
    private final CatalogSynchronizer synchronizer;
    private final JdbcClient jdbc;
    private final InventoryProperties properties;

    public CatalogSyncJob(CatalogClient client, CatalogSynchronizer synchronizer, JdbcClient jdbc,
            InventoryProperties properties) {
        this.client = client;
        this.synchronizer = synchronizer;
        this.jdbc = jdbc;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString = "${lotou.inventory.catalog.poll-interval:2s}")
    void run() {
        try {
            sync();
        }
        catch (RuntimeException ex) {
            log.warn("Leitura do catálogo falhou; tenta de novo na próxima rodada: {}", ex.toString());
        }
    }

    /** Aplica tudo o que mudou desde a última leitura. Devolve quantos shows foram lidos. */
    public int sync() {
        Instant lastSeen = lastUpdatedAt();
        // Recua um pouco: dois shows gravados quase juntos podem ficar visíveis fora de ordem.
        Instant since = lastSeen == null ? null : lastSeen.minus(this.properties.catalog().overlap());

        int read = 0;
        Instant newest = lastSeen;
        String cursor = null;
        do {
            CatalogShow.Page page = this.client.fetch(since, cursor);
            for (CatalogShow show : page.items()) {
                this.synchronizer.apply(show);
                if (newest == null || show.updatedAt().isAfter(newest)) {
                    newest = show.updatedAt();
                }
                read++;
            }
            cursor = page.nextCursor();
        }
        while (cursor != null);

        if (newest != null && !newest.equals(lastSeen)) {
            this.jdbc.sql("""
                    UPDATE catalog_sync SET last_updated_at = :newest
                    WHERE id = 1 AND (last_updated_at IS NULL OR last_updated_at < :newest)
                    """).param("newest", Timestamp.from(newest)).update();
        }
        return read;
    }

    private Instant lastUpdatedAt() {
        return this.jdbc.sql("SELECT last_updated_at FROM catalog_sync WHERE id = 1")
                .query(Timestamp.class)
                .optional()
                .map(Timestamp::toInstant)
                .orElse(null);
    }
}

package br.com.lotou.order.catalog;

import java.sql.Timestamp;
import java.time.Clock;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.pricing.ServiceFeePayer;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** A cópia local do catálogo: só a versão mais nova de cada show muda a linha. */
@Component
public class ShowCatalog {

    private final JdbcClient jdbc;
    private final Clock clock;

    public ShowCatalog(JdbcClient jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    public Optional<LocalShow> find(UUID showId) {
        return this.jdbc.sql("""
                SELECT id, producer_id, status, title, starts_at, service_fee_paid_by, version
                FROM shows WHERE id = :id
                """)
                .param("id", showId)
                .query((rs, row) -> new LocalShow(rs.getObject("id", UUID.class), rs.getString("producer_id"),
                        rs.getString("status"), rs.getString("title"), rs.getTimestamp("starts_at").toInstant(),
                        ServiceFeePayer.valueOf(rs.getString("service_fee_paid_by")), rs.getInt("version")))
                .optional();
    }

    /**
     * Aplica uma versão do show. Devolve o status anterior quando a versão era mais nova que a
     * local (vazio se o show não existia), ou {@code null} quando a mensagem era velha ou repetida.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Applied apply(LocalShow show) {
        Optional<String> previous = this.jdbc.sql("SELECT status FROM shows WHERE id = :id FOR UPDATE")
                .param("id", show.id()).query(String.class).optional();
        int changed = this.jdbc.sql("""
                INSERT INTO shows (id, producer_id, status, title, starts_at, service_fee_paid_by, version, updated_at)
                VALUES (:id, :producer, :status, :title, :startsAt, :feePaidBy, :version, :now)
                ON CONFLICT (id) DO UPDATE SET producer_id = EXCLUDED.producer_id, status = EXCLUDED.status,
                    title = EXCLUDED.title, starts_at = EXCLUDED.starts_at,
                    service_fee_paid_by = EXCLUDED.service_fee_paid_by, version = EXCLUDED.version,
                    updated_at = EXCLUDED.updated_at
                WHERE shows.version < EXCLUDED.version
                """)
                .param("id", show.id())
                .param("producer", show.producerId())
                .param("status", show.status())
                .param("title", show.title())
                .param("startsAt", Timestamp.from(show.startsAt()))
                .param("feePaidBy", show.serviceFeePaidBy().name())
                .param("version", show.version())
                .param("now", Timestamp.from(this.clock.instant()))
                .update();
        return changed == 0 ? null : new Applied(previous.orElse(null));
    }

    /** @param previousStatus o status antes desta versão; {@code null} se o show era novo */
    public record Applied(String previousStatus) {
    }
}

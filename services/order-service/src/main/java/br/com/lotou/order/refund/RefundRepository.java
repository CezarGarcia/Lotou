package br.com.lotou.order.refund;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** A tabela {@code refunds}. As mudanças exigem a transação de quem chama. */
@Repository
class RefundRepository {

    private static final String COLUMNS = "order_id, reason, status, amount_cents, failures, deadline, requested_at";

    private final JdbcClient jdbc;

    RefundRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    boolean exists(UUID orderId) {
        return this.jdbc.sql("SELECT EXISTS (SELECT 1 FROM refunds WHERE order_id = :id)").param("id", orderId)
                .query(Boolean.class).single();
    }

    @Transactional(propagation = Propagation.MANDATORY)
    Optional<Refund> lock(UUID orderId) {
        return this.jdbc.sql("SELECT " + COLUMNS + " FROM refunds WHERE order_id = :id FOR UPDATE")
                .param("id", orderId).query(RefundRepository::map).optional();
    }

    /** Cria o reembolso; devolve {@code false} se o pedido já tinha um. */
    @Transactional(propagation = Propagation.MANDATORY)
    boolean insert(UUID orderId, Refund.Reason reason, Refund.Status status, long amountCents, Instant deadline,
            Instant now) {
        return this.jdbc.sql("""
                INSERT INTO refunds (order_id, reason, status, amount_cents, failures, deadline, requested_at, updated_at)
                VALUES (:id, :reason, :status, :amount, 0, :deadline, :now, :now)
                ON CONFLICT (order_id) DO NOTHING
                """)
                .param("id", orderId)
                .param("reason", reason.name())
                .param("status", status.name())
                .param("amount", amountCents)
                .param("deadline", deadline == null ? null : Timestamp.from(deadline))
                .param("now", Timestamp.from(now))
                .update() == 1;
    }

    /**
     * Põe na fila o reembolso de todo pedido confirmado de um show cancelado que ainda não tem um,
     * inclusive os que confirmaram depois do cancelamento. Devolve quantos entraram.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    int queueCancelledShows(UUID showId, Instant now) {
        return this.jdbc.sql("""
                INSERT INTO refunds (order_id, reason, status, amount_cents, failures, requested_at, updated_at)
                SELECT o.id, 'SHOW_CANCELLED', 'QUEUED', o.total_cents, 0, :now, :now
                FROM orders o JOIN shows s ON s.id = o.show_id
                WHERE s.status = 'CANCELLED' AND o.status = 'CONFIRMED' AND (CAST(:show AS uuid) IS NULL OR s.id = :show)
                ON CONFLICT (order_id) DO NOTHING
                """)
                .param("show", showId)
                .param("now", Timestamp.from(now))
                .update();
    }

    /** Os próximos da fila, do mais antigo ao mais novo. */
    List<UUID> queued(int limit) {
        return this.jdbc.sql("""
                SELECT order_id FROM refunds WHERE status = 'QUEUED' ORDER BY requested_at, order_id LIMIT :limit
                """)
                .param("limit", limit).query(UUID.class).list();
    }

    /** Estornos sem resposta no prazo. */
    List<UUID> overdue(Instant now, int limit) {
        return this.jdbc.sql("""
                SELECT order_id FROM refunds WHERE status = 'REFUNDING' AND deadline <= :now ORDER BY deadline LIMIT :limit
                """)
                .param("now", Timestamp.from(now)).param("limit", limit).query(UUID.class).list();
    }

    @Transactional(propagation = Propagation.MANDATORY)
    void update(UUID orderId, Refund.Status status, int failures, Instant deadline, Instant now) {
        this.jdbc.sql("""
                UPDATE refunds SET status = :status, failures = :failures, deadline = :deadline, updated_at = :now,
                    completed_at = CASE WHEN :status = 'COMPLETED' THEN :now ELSE completed_at END
                WHERE order_id = :id
                """)
                .param("id", orderId)
                .param("status", status.name())
                .param("failures", failures)
                .param("deadline", deadline == null ? null : Timestamp.from(deadline))
                .param("now", Timestamp.from(now))
                .update();
    }

    private static Refund map(ResultSet rs, int row) throws SQLException {
        Timestamp deadline = rs.getTimestamp("deadline");
        return new Refund(rs.getObject("order_id", UUID.class), Refund.Reason.valueOf(rs.getString("reason")),
                Refund.Status.valueOf(rs.getString("status")), rs.getLong("amount_cents"), rs.getInt("failures"),
                deadline == null ? null : deadline.toInstant(), rs.getTimestamp("requested_at").toInstant());
    }
}

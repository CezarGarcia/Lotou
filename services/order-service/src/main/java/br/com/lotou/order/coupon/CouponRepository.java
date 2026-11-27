package br.com.lotou.order.coupon;

import java.sql.Array;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/** Cupons e usos, direto em SQL: o uso é um update condicional, não uma leitura seguida de escrita. */
@Repository
public class CouponRepository {

    private static final String COLUMNS = """
            id, show_id, code, kind, percent, amount_cents, max_uses, uses, status, valid_until, sector_ids, created_at
            """;

    private final JdbcClient jdbc;

    public CouponRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public void insert(Coupon coupon, String createdBy, String idempotencyKey) {
        this.jdbc.sql("""
                INSERT INTO coupons (id, show_id, code, kind, percent, amount_cents, max_uses, uses, status,
                                     valid_until, sector_ids, idempotency_key, created_by, created_at, updated_at)
                VALUES (:id, :show, :code, :kind, :percent, :amount, :maxUses, 0, 'ACTIVE', :validUntil,
                        CAST(:sectors AS uuid[]), :key, :by, :at, :at)
                """)
                .param("id", coupon.id())
                .param("show", coupon.showId())
                .param("code", coupon.code())
                .param("kind", coupon.kind().name())
                .param("percent", coupon.percent())
                .param("amount", coupon.amountCents())
                .param("maxUses", coupon.maxUses())
                .param("validUntil", Timestamp.from(coupon.validUntil()))
                .param("sectors", "{" + String.join(",", coupon.sectorIds().stream().map(UUID::toString).toList()) + "}")
                .param("key", idempotencyKey)
                .param("by", createdBy)
                .param("at", Timestamp.from(coupon.createdAt()))
                .update();
    }

    public Optional<Coupon> findById(UUID id) {
        return this.jdbc.sql("SELECT " + COLUMNS + " FROM coupons WHERE id = :id").param("id", id)
                .query(CouponRepository::map).optional();
    }

    public Optional<Coupon> findByCode(UUID showId, String code) {
        return this.jdbc.sql("SELECT " + COLUMNS + " FROM coupons WHERE show_id = :show AND code = :code")
                .param("show", showId).param("code", code).query(CouponRepository::map).optional();
    }

    public Optional<Coupon> findByIdempotencyKey(String createdBy, String key) {
        return this.jdbc.sql("SELECT " + COLUMNS + " FROM coupons WHERE created_by = :by AND idempotency_key = :key")
                .param("by", createdBy).param("key", key).query(CouponRepository::map).optional();
    }

    /** Cupons do show, do mais novo ao mais antigo (UUID v7), a partir do cursor. */
    public List<Coupon> list(UUID showId, UUID before, int limit) {
        return this.jdbc.sql("SELECT " + COLUMNS + """
                FROM coupons WHERE show_id = :show AND (CAST(:before AS uuid) IS NULL OR id < :before)
                ORDER BY id DESC LIMIT :limit
                """)
                .param("show", showId).param("before", before).param("limit", limit)
                .query(CouponRepository::map).list();
    }

    public int setStatus(UUID id, Coupon.Status status, Instant now) {
        return this.jdbc.sql("UPDATE coupons SET status = :status, updated_at = :now WHERE id = :id")
                .param("status", status.name()).param("now", Timestamp.from(now)).param("id", id).update();
    }

    /** Quanto desconto o cupom já deu, contando só os usos que não foram devolvidos. */
    public long discountGiven(UUID couponId) {
        return this.jdbc.sql("""
                SELECT coalesce(sum(discount_cents), 0) FROM coupon_redemptions
                WHERE coupon_id = :id AND returned_at IS NULL
                """).param("id", couponId).query(Long.class).single();
    }

    /**
     * Conta um uso, só se ainda houver: o update condicional trava a linha do cupom, e de várias
     * compras simultâneas só as que cabem no limite passam (ADR 33).
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean redeem(UUID couponId, UUID orderId, long discountCents, Instant now) {
        int counted = this.jdbc.sql("""
                UPDATE coupons SET uses = uses + 1, updated_at = :now
                WHERE id = :id AND uses < max_uses AND status = 'ACTIVE' AND valid_until > :now
                """).param("id", couponId).param("now", Timestamp.from(now)).update();
        if (counted == 0) {
            return false;
        }
        this.jdbc.sql("""
                INSERT INTO coupon_redemptions (order_id, coupon_id, discount_cents, redeemed_at)
                VALUES (:order, :coupon, :discount, :now)
                """).param("order", orderId).param("coupon", couponId).param("discount", discountCents)
                .param("now", Timestamp.from(now)).update();
        return true;
    }

    /** Devolve o uso do pedido, uma vez só: pedido cancelado ou reembolsado. */
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean giveBack(UUID orderId, Instant now) {
        Optional<UUID> coupon = this.jdbc.sql("""
                UPDATE coupon_redemptions SET returned_at = :now
                WHERE order_id = :order AND returned_at IS NULL
                RETURNING coupon_id
                """).param("order", orderId).param("now", Timestamp.from(now)).query(UUID.class).optional();
        coupon.ifPresent(id -> this.jdbc.sql("""
                UPDATE coupons SET uses = uses - 1, updated_at = :now WHERE id = :id AND uses > 0
                """).param("id", id).param("now", Timestamp.from(now)).update());
        return coupon.isPresent();
    }

    private static Coupon map(ResultSet rs, int row) throws SQLException {
        Array sectors = rs.getArray("sector_ids");
        List<UUID> sectorIds = sectors == null ? List.of() : Arrays.asList((UUID[]) sectors.getArray());
        Object percent = rs.getObject("percent");
        Object amount = rs.getObject("amount_cents");
        return new Coupon(rs.getObject("id", UUID.class), rs.getObject("show_id", UUID.class), rs.getString("code"),
                Coupon.Kind.valueOf(rs.getString("kind")), percent == null ? null : ((Number) percent).intValue(),
                amount == null ? null : ((Number) amount).longValue(), rs.getInt("max_uses"), rs.getInt("uses"),
                Coupon.Status.valueOf(rs.getString("status")), rs.getTimestamp("valid_until").toInstant(),
                sectorIds, rs.getTimestamp("created_at").toInstant());
    }
}

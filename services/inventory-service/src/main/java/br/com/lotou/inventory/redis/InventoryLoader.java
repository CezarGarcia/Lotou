package br.com.lotou.inventory.redis;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

import br.com.lotou.inventory.catalog.CatalogCache;
import br.com.lotou.inventory.catalog.Sector;
import br.com.lotou.inventory.catalog.SectorRepository;
import br.com.lotou.inventory.catalog.Show;
import br.com.lotou.inventory.catalog.ShowRepository;
import br.com.lotou.inventory.lot.Lot;
import br.com.lotou.inventory.lot.LotRepository;
import br.com.lotou.inventory.lot.LotStatus;
import br.com.lotou.inventory.lot.SectorLots;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.connection.DefaultStringRedisConnection;
import org.springframework.data.redis.connection.StringRedisConnection;
import org.springframework.data.redis.core.Cursor;
import org.springframework.data.redis.core.RedisCallback;
import org.springframework.data.redis.core.ScanOptions;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Carrega no {@code redis-core} o estado de venda de um show, a partir do Postgres: status de cada
 * setor e lote em venda, contadores dos lotes, bitmap e chaves das cadeiras ocupadas, cotas por
 * CPF, reservas ativas e chaves de idempotência recentes.
 *
 * <p>Roda na abertura das vendas, protegido por lock distribuído. É também a reconciliação: se o
 * Redis perder os dados de um show com as vendas abertas, o job percebe que a marca
 * {@code show:{id}} sumiu e carrega de novo a partir do Postgres, que é a cópia durável (ADR 26).
 * A marca é gravada por último: até ela existir, as reservas do show respondem "abrindo as vendas".
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class InventoryLoader {

    private static final Logger log = LoggerFactory.getLogger(InventoryLoader.class);
    private static final Duration LOAD_LOCK = Duration.ofSeconds(60);
    private static final Duration IDEMPOTENCY_WINDOW = Duration.ofHours(24);

    private record HeldReservation(UUID id, UUID sectorId, UUID lotId, String buyerId, String cpfHash, int quantity,
            Instant expiresAt, Instant createdAt, Instant updatedAt, String idempotencyKey, String requestHash) {
    }

    private record OccupiedSeat(UUID id, UUID sectorId, int position, String label, UUID reservationId) {
    }

    private record RecentKey(UUID reservationId, String buyerId, String idempotencyKey, String requestHash) {
    }

    private final StringRedisTemplate redis;
    private final RedisLock lock;
    private final ShowRepository shows;
    private final SectorRepository sectors;
    private final LotRepository lots;
    private final JdbcClient jdbc;
    private final CatalogCache catalog;
    private final TransactionTemplate readOnly;

    public InventoryLoader(StringRedisTemplate redis, RedisLock lock, ShowRepository shows,
            SectorRepository sectors, LotRepository lots, JdbcClient jdbc, CatalogCache catalog,
            PlatformTransactionManager transactionManager) {
        this.redis = redis;
        this.lock = lock;
        this.shows = shows;
        this.sectors = sectors;
        this.lots = lots;
        this.jdbc = jdbc;
        this.catalog = catalog;
        this.readOnly = new TransactionTemplate(transactionManager);
        this.readOnly.setReadOnly(true);
    }

    public boolean loaded(UUID showId) {
        return Boolean.TRUE.equals(this.redis.hasKey(RedisKeys.show(showId)));
    }

    /** Carrega o show, se ainda não está carregado e nenhuma outra instância está carregando. */
    public boolean load(UUID showId) {
        Optional<RedisLock.Lease> lease = this.lock.tryAcquire("load:" + showId, LOAD_LOCK);
        if (lease.isEmpty()) {
            return false;
        }
        try (RedisLock.Lease ignored = lease.get()) {
            if (loaded(showId)) {
                return false;
            }
            this.catalog.forget(showId);
            this.readOnly.executeWithoutResult(status -> write(showId));
            log.info("Estoque do show {} carregado no Redis", showId);
            return true;
        }
    }

    private void write(UUID showId) {
        Show show = this.shows.findById(showId).orElseThrow();
        List<Sector> showSectors = this.sectors.findByShow(showId);
        Map<UUID, List<Lot>> lotsBySector = this.lots.findByShow(showId).stream()
                .collect(Collectors.groupingBy(Lot::getSectorId));
        List<OccupiedSeat> occupied = occupiedSeats(showId);
        Map<UUID, List<OccupiedSeat>> seatsByReservation = occupied.stream()
                .collect(Collectors.groupingBy(OccupiedSeat::reservationId, LinkedHashMap::new, Collectors.toList()));
        List<HeldReservation> held = heldReservations(showId);
        Map<String, Integer> limits = limits(showId);
        List<RecentKey> recentKeys = recentKeys(showId);

        clear(showId, showSectors, lotsBySector);
        this.redis.executePipelined((RedisCallback<Object>) connection -> {
            StringRedisConnection c = new DefaultStringRedisConnection(connection);
            for (Sector sector : showSectors) {
                writeSector(c, showId, sector, lotsBySector.getOrDefault(sector.getId(), List.of()));
            }
            for (OccupiedSeat seat : occupied) {
                c.set(RedisKeys.seat(showId, seat.id()), seat.reservationId().toString());
                c.setBit(RedisKeys.seatMap(showId, seat.sectorId()), seat.position(), true);
            }
            limits.forEach((cpfHash, quantity) ->
                    c.set(RedisKeys.purchaseLimit(showId, cpfHash), String.valueOf(quantity)));
            for (HeldReservation reservation : held) {
                writeReservation(c, showId, reservation, lotsBySector,
                        seatsByReservation.getOrDefault(reservation.id(), List.of()));
            }
            for (RecentKey key : recentKeys) {
                c.pSetEx(idempotencyKey(key.buyerId(), key.idempotencyKey()), IDEMPOTENCY_WINDOW.toMillis(),
                        key.reservationId() + "|" + key.requestHash());
            }
            // Por último: a marca libera as reservas do show.
            c.hMSet(RedisKeys.show(showId), Map.of(
                    "highDemand", show.isHighDemand() ? "1" : "0",
                    "loadedAt", String.valueOf(System.currentTimeMillis())));
            return null;
        });
    }

    /** Apaga o que tiver sobrado de uma carga anterior interrompida. */
    private void clear(UUID showId, List<Sector> showSectors, Map<UUID, List<Lot>> lotsBySector) {
        List<String> keys = new ArrayList<>();
        for (Sector sector : showSectors) {
            keys.add(RedisKeys.sector(showId, sector.getId()));
            keys.add(RedisKeys.nextLots(showId, sector.getId()));
            keys.add(RedisKeys.seatMap(showId, sector.getId()));
            lotsBySector.getOrDefault(sector.getId(), List.of()).forEach(lot -> keys.add(RedisKeys.lotStock(lot.getId())));
        }
        this.redis.delete(keys);
        for (String pattern : List.of("seat:" + showId + ":*", "limit:" + showId + ":*")) {
            try (Cursor<String> cursor = this.redis.scan(ScanOptions.scanOptions().match(pattern).count(1000).build())) {
                List<String> found = new ArrayList<>();
                cursor.forEachRemaining(found::add);
                if (!found.isEmpty()) {
                    this.redis.delete(found);
                }
            }
        }
    }

    /**
     * O setor no Redis a partir dos lotes no Postgres: status, lote atual, fila de lotes agendados e
     * contadores. O "lote atual" de um setor esgotado é o último lote, que reabre se um ingresso
     * voltar (ADR 25).
     */
    private static void writeSector(StringRedisConnection c, UUID showId, Sector sector, List<Lot> lots) {
        List<Lot> ordered = lots.stream().sorted(Comparator.comparingInt(Lot::getPosition)).toList();
        var sectorLots = new SectorLots(ordered);
        SectorLots.Sale sale = sectorLots.sale();
        Lot current = sectorLots.current()
                .or(() -> ordered.stream().filter(lot -> lot.is(LotStatus.CLOSED)).findFirst())
                .or(() -> ordered.stream().filter(lot -> lot.is(LotStatus.SOLD_OUT))
                        .max(Comparator.comparingInt(Lot::getPosition)))
                .orElse(ordered.isEmpty() ? null : ordered.getFirst());

        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("status", sale.name());
        fields.put("kind", sector.getKind().name());
        if (current != null) {
            fields.put("lot", current.getId().toString());
        }
        c.hMSet(RedisKeys.sector(showId, sector.getId()), fields);
        for (Lot lot : ordered) {
            c.set(RedisKeys.lotStock(lot.getId()), String.valueOf(lot.getAvailable()));
            if (lot.is(LotStatus.SCHEDULED) && sale != SectorLots.Sale.NOT_OPEN) {
                c.rPush(RedisKeys.nextLots(showId, sector.getId()), lot.getId().toString());
            }
        }
    }

    private static void writeReservation(StringRedisConnection c, UUID showId, HeldReservation r,
            Map<UUID, List<Lot>> lotsBySector, List<OccupiedSeat> seats) {
        List<OccupiedSeat> ordered = seats.stream().sorted(Comparator.comparingInt(OccupiedSeat::position)).toList();
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("status", "HELD");
        fields.put("buyer", r.buyerId());
        fields.put("show", showId.toString());
        fields.put("sector", r.sectorId().toString());
        fields.put("cpf", r.cpfHash());
        fields.put("qty", String.valueOf(r.quantity()));
        fields.put("lot", r.lotId().toString());
        fields.put("seats", join(ordered.stream().map(seat -> seat.id().toString()).toList()));
        fields.put("positions", join(ordered.stream().map(seat -> String.valueOf(seat.position())).toList()));
        fields.put("labels", join(ordered.stream().map(OccupiedSeat::label).toList()));
        fields.put("expiresAt", String.valueOf(r.expiresAt().toEpochMilli()));
        fields.put("createdAt", String.valueOf(r.createdAt().toEpochMilli()));
        fields.put("updatedAt", String.valueOf(r.updatedAt().toEpochMilli()));
        fields.put("idemKey", r.idempotencyKey());
        fields.put("rhash", r.requestHash());
        c.hMSet(RedisKeys.reservation(r.id()), fields);
    }

    private List<OccupiedSeat> occupiedSeats(UUID showId) {
        return this.jdbc.sql("""
                SELECT id, sector_id, position, label, reservation_id FROM seats
                WHERE show_id = :showId AND status <> 'AVAILABLE' AND reservation_id IS NOT NULL
                """)
                .param("showId", showId)
                .query((rs, row) -> new OccupiedSeat(rs.getObject("id", UUID.class),
                        rs.getObject("sector_id", UUID.class), rs.getInt("position"), rs.getString("label"),
                        rs.getObject("reservation_id", UUID.class)))
                .list();
    }

    private List<HeldReservation> heldReservations(UUID showId) {
        return this.jdbc.sql("""
                SELECT r.id, r.sector_id, r.buyer_id, r.cpf_hash, r.quantity, r.expires_at, r.created_at,
                       r.updated_at, r.idempotency_key, r.request_hash,
                       (SELECT i.lot_id FROM reservation_items i WHERE i.reservation_id = r.id
                        ORDER BY i.position LIMIT 1) AS lot_id
                FROM reservations r WHERE r.show_id = :showId AND r.status = 'HELD'
                """)
                .param("showId", showId)
                .query((rs, row) -> new HeldReservation(rs.getObject("id", UUID.class),
                        rs.getObject("sector_id", UUID.class), rs.getObject("lot_id", UUID.class),
                        rs.getString("buyer_id"), rs.getString("cpf_hash"),
                        rs.getInt("quantity"), rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("updated_at").toInstant(),
                        rs.getString("idempotency_key"), rs.getString("request_hash")))
                .list();
    }

    private Map<String, Integer> limits(UUID showId) {
        Map<String, Integer> limits = new LinkedHashMap<>();
        this.jdbc.sql("SELECT cpf_hash, quantity FROM purchase_limits WHERE show_id = :showId AND quantity > 0")
                .param("showId", showId)
                .query((rs, row) -> limits.put(rs.getString("cpf_hash"), rs.getInt("quantity")))
                .list();
        return limits;
    }

    private List<RecentKey> recentKeys(UUID showId) {
        return this.jdbc.sql("""
                SELECT id, buyer_id, idempotency_key, request_hash FROM reservations
                WHERE show_id = :showId AND created_at > :since
                """)
                .param("showId", showId)
                .param("since", Timestamp.from(Instant.now().minus(IDEMPOTENCY_WINDOW)))
                .query((rs, row) -> new RecentKey(rs.getObject("id", UUID.class), rs.getString("buyer_id"),
                        rs.getString("idempotency_key"), rs.getString("request_hash")))
                .list();
    }

    /** A mesma chave que {@code RedisReservationEngine} usa. */
    public static String idempotencyKey(String buyerId, String idempotencyKey) {
        try {
            return "idem:reservation:" + HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest((buyerId + "\n" + idempotencyKey).getBytes(StandardCharsets.UTF_8)));
        }
        catch (java.security.NoSuchAlgorithmException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static String join(List<String> values) {
        return String.join(",", values);
    }
}

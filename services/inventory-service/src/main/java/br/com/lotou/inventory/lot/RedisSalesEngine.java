package br.com.lotou.inventory.lot;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogCache;
import br.com.lotou.inventory.catalog.CatalogCache.LotInfo;
import br.com.lotou.inventory.catalog.CatalogCache.SeatInfo;
import br.com.lotou.inventory.catalog.Sector;
import br.com.lotou.inventory.catalog.SectorRepository;
import br.com.lotou.inventory.catalog.Show;
import br.com.lotou.inventory.catalog.ShowRepository;
import br.com.lotou.inventory.redis.InventoryLoader;
import br.com.lotou.inventory.redis.LuaScripts;
import br.com.lotou.inventory.redis.RedisKeys;
import br.com.lotou.inventory.shared.problem.Problems;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Ciclo das vendas e disponibilidade no {@code redis-core} (fase 2).
 *
 * <p>Depois que o estoque de um show é carregado, o Redis é a fonte da verdade do que está à venda:
 * virar lote, pausar e encerrar são scripts Lua, atômicos com as reservas, e chegam ao Postgres
 * pelo stream. Antes da carga (vendas ainda não abertas), a leitura vem do Postgres.
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class RedisSalesEngine implements SalesEngine {

    private static final Logger log = LoggerFactory.getLogger(RedisSalesEngine.class);

    private final SalesOpening opening;
    private final InventoryLoader loader;
    private final LuaScripts scripts;
    private final StringRedisTemplate redis;
    private final CatalogCache catalog;
    private final ShowRepository shows;
    private final SectorRepository sectors;
    private final LotRepository lots;
    private final JdbcClient jdbc;
    private final TransactionTemplate transaction;

    public RedisSalesEngine(SalesOpening opening, InventoryLoader loader, LuaScripts scripts,
            StringRedisTemplate redis, CatalogCache catalog, ShowRepository shows, SectorRepository sectors,
            LotRepository lots, JdbcClient jdbc, PlatformTransactionManager transactionManager) {
        this.opening = opening;
        this.loader = loader;
        this.scripts = scripts;
        this.redis = redis;
        this.catalog = catalog;
        this.shows = shows;
        this.sectors = sectors;
        this.lots = lots;
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
    }

    /** Abre no Postgres e carrega o estoque no Redis. Se a carga falhar, {@link #maintain} tenta de novo. */
    @Override
    public boolean openSales(UUID showId, Instant now) {
        boolean opened = this.opening.open(showId, now);
        if (opened) {
            this.loader.load(showId);
        }
        return opened;
    }

    /**
     * Fecha cada setor no Redis (script) e marca o show como encerrado no Postgres. Se cair no meio,
     * a próxima rodada encontra o show ainda aberto e repete: fechar um setor fechado não faz nada.
     */
    @Override
    public boolean closeSales(UUID showId, Instant now) {
        return Boolean.TRUE.equals(this.transaction.execute(status -> {
            Show show = this.shows.lockById(showId).orElseThrow(() -> Problems.notFound("Show"));
            if (!show.dueToClose(now)) {
                return false;
            }
            for (Sector sector : this.sectors.findByShow(showId)) {
                this.scripts.run("close", showId, sector.getId());
            }
            show.markSalesClosed(now);
            log.info("Vendas encerradas: show {}", showId);
            return true;
        }));
    }

    /** O próximo lote do setor cuja data chegou; o script só vira se ele ainda é o próximo da fila. */
    @Override
    public boolean turnByDate(SectorRef sector, Instant now) {
        List<UUID> due = this.jdbc.sql("""
                SELECT id FROM lots
                WHERE show_id = :showId AND sector_id = :sectorId AND status = 'SCHEDULED' AND opens_at <= :now
                ORDER BY position LIMIT 1
                """)
                .param("showId", sector.showId())
                .param("sectorId", sector.sectorId())
                .param("now", java.sql.Timestamp.from(now))
                .query(UUID.class)
                .list();
        if (due.isEmpty()) {
            return false;
        }
        boolean turned = this.scripts.run("turn", sector.showId(), sector.sectorId(), due.getFirst()).is("OK");
        if (turned) {
            log.info("Lote virou por data: show {} setor {}", sector.showId(), sector.sectorId());
        }
        return turned;
    }

    @Override
    public LotView pause(UUID lotId, String producerId) {
        return changeLot(lotId, producerId, "PAUSE", LotStatus.PAUSED);
    }

    @Override
    public LotView resume(UUID lotId, String producerId) {
        return changeLot(lotId, producerId, "RESUME", LotStatus.ON_SALE);
    }

    private LotView changeLot(UUID lotId, String producerId, String action, LotStatus target) {
        Lot lot = this.transaction.execute(status ->
                PostgresSalesEngine.ownedLot(lotId, producerId, this.lots, this.shows));
        LuaScripts.Result result = this.scripts.run("pause", lot.getShowId(), lot.getSectorId(), lotId, action);
        if (!result.is("OK")) {
            log.warn("Transição de estado recusada: lote {} de {} para {}", lotId, result.value(1), target);
            throw Problems.invalidTransition("Um lote", LotStatus.valueOf(result.value(1)), target);
        }
        return new LotView(lot.getId(), lot.getShowId(), lot.getSectorId(), lot.getName(), lot.getPriceCents(),
                Integer.parseInt(result.value(2)), LotStatus.valueOf(result.value(1)));
    }

    /** Lê o contador do lote em venda direto do Redis: ingressos restantes nunca vêm de cache. */
    @Override
    public List<SectorAvailability> availability(UUID showId) {
        List<Sector> showSectors = this.transaction.execute(status -> {
            if (!this.shows.existsById(showId)) {
                throw Problems.notFound("Show");
            }
            return this.sectors.findByShow(showId);
        });
        if (!this.loader.loaded(showId)) {
            return this.transaction.execute(status -> {
                List<Lot> showLots = this.lots.findByShow(showId);
                return showSectors.stream()
                        .map(sector -> PostgresSalesEngine.describe(sector, showLots.stream()
                                .filter(lot -> lot.getSectorId().equals(sector.getId()))
                                .toList()))
                        .toList();
            });
        }
        List<SectorAvailability> result = new ArrayList<>();
        for (Sector sector : showSectors) {
            Map<Object, Object> state = this.redis.opsForHash().entries(RedisKeys.sector(showId, sector.getId()));
            SectorLots.Sale sale = SectorLots.Sale.valueOf(String.valueOf(state.getOrDefault("status", "NOT_OPEN")));
            CurrentLot current = null;
            int available = 0;
            if ((sale == SectorLots.Sale.ON_SALE || sale == SectorLots.Sale.PAUSED) && state.get("lot") != null) {
                UUID lotId = UUID.fromString(state.get("lot").toString());
                LotInfo lot = this.catalog.lot(lotId);
                current = new CurrentLot(lot.id(), lot.name(), lot.priceCents());
                if (sale == SectorLots.Sale.ON_SALE) {
                    available = Integer.parseInt(String.valueOf(
                            this.redis.opsForValue().get(RedisKeys.lotStock(lotId))));
                }
            }
            result.add(new SectorAvailability(sector.getId(), sector.getName(), sector.getKind(),
                    sector.getCapacity(), sale, current, available));
        }
        return result;
    }

    /**
     * O mapa do setor numa leitura só: o bitmap tem um bit por cadeira (1 é ocupada), então um setor
     * de 5 mil cadeiras cabe em cerca de 625 bytes (ADR 5).
     */
    @Override
    public List<SeatAvailability> seats(UUID showId, UUID sectorId) {
        boolean exists = Boolean.TRUE.equals(this.transaction.execute(status ->
                this.sectors.existsById(new Sector.Key(showId, sectorId))));
        if (!exists) {
            throw Problems.notFound("Setor");
        }
        if (!this.loader.loaded(showId)) {
            return this.transaction.execute(status -> this.jdbc.sql("""
                    SELECT label, status FROM seats WHERE show_id = :showId AND sector_id = :sectorId
                    ORDER BY position
                    """)
                    .param("showId", showId)
                    .param("sectorId", sectorId)
                    .query((rs, row) -> new SeatAvailability(rs.getString("label"),
                            "AVAILABLE".equals(rs.getString("status"))))
                    .list());
        }
        byte[] bitmap = this.redis.execute((org.springframework.data.redis.core.RedisCallback<byte[]>) connection ->
                connection.stringCommands().get(RedisKeys.seatMap(showId, sectorId)
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        // Com as vendas abertas, as cadeiras não mudam mais: podem vir da memória.
        Map<String, SeatInfo> seats = this.catalog.seats(showId, sectorId);
        return seats.values().stream()
                .map(seat -> new SeatAvailability(seat.label(), !occupied(bitmap, seat.position())))
                .toList();
    }

    /** No Redis, o bit 0 é o mais significativo do primeiro byte. */
    static boolean occupied(byte[] bitmap, int position) {
        int index = position / 8;
        return bitmap != null && index < bitmap.length && (bitmap[index] & (0x80 >> (position % 8))) != 0;
    }

    /** Recarrega shows com as vendas abertas que não estão no Redis (abertura interrompida ou perda de dados). */
    @Override
    public void maintain(Instant now) {
        List<UUID> open = this.jdbc.sql("""
                SELECT id FROM shows WHERE sales_opened_at IS NOT NULL AND sales_closed_at IS NULL
                """).query(UUID.class).list();
        for (UUID showId : open) {
            if (!this.loader.loaded(showId) && this.loader.load(showId)) {
                log.warn("Show {} estava com as vendas abertas e sem estoque no Redis: recarregado do Postgres",
                        showId);
            }
        }
    }
}

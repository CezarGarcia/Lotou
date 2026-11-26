package br.com.lotou.inventory.catalog;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Dados de referência que não mudam depois que as vendas abrem, guardados em memória para o caminho
 * quente da reserva não ir ao Postgres: nome e preço dos lotes, e o ID e a posição de cada cadeira.
 *
 * <p>Antes da abertura o catálogo ainda pode trocar lotes e cadeiras (com IDs novos). O tipo e o
 * nome de um setor vêm do local e não mudam; as cadeiras só são lidas com as vendas abertas, e a
 * carga do estoque descarta o que estiver em memória sobre o show.
 */
@Component
public class CatalogCache {

    /** @param priceCents preço em centavos, congelado no lote */
    public record LotInfo(UUID id, String name, long priceCents) {
    }

    /** O que a reserva precisa saber do setor. */
    public record SectorInfo(UUID showId, UUID id, String name, SectorKind kind) {
    }

    /** @param position posição da cadeira no setor, que é o bit dela no bitmap */
    public record SeatInfo(UUID id, String label, int position) {
    }

    private record SectorKey(UUID showId, UUID sectorId) {
    }

    private final JdbcClient jdbc;
    private final Map<UUID, LotInfo> lots = new ConcurrentHashMap<>();
    private final Map<SectorKey, SectorInfo> sectors = new ConcurrentHashMap<>();
    private final Map<SectorKey, Map<String, SeatInfo>> seats = new ConcurrentHashMap<>();

    public CatalogCache(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    // As leituras do banco ficam fora do computeIfAbsent de propósito: ele segura um lock
    // (synchronized) durante o cálculo, e no Java 21 uma virtual thread presa num synchronized
    // prende também a thread do sistema. Com centenas de reservas ao mesmo tempo, as threads do
    // sistema acabam e as conexões do pool não conseguem voltar. Ler duas vezes o mesmo dado
    // imutável na corrida é inofensivo.

    public LotInfo lot(UUID lotId) {
        LotInfo cached = this.lots.get(lotId);
        if (cached != null) {
            return cached;
        }
        LotInfo loaded = this.jdbc.sql("SELECT id, name, price_cents FROM lots WHERE id = :id")
                .param("id", lotId)
                .query((rs, row) -> new LotInfo(rs.getObject("id", UUID.class), rs.getString("name"),
                        rs.getLong("price_cents")))
                .single();
        LotInfo raced = this.lots.putIfAbsent(lotId, loaded);
        return raced != null ? raced : loaded;
    }

    /**
     * O setor, sem ir ao banco depois da primeira vez. É a primeira coisa que toda reserva consulta;
     * na abertura das vendas, milhares de reservas ao mesmo tempo fariam fila no pool de conexões.
     */
    public Optional<SectorInfo> sector(UUID showId, UUID sectorId) {
        SectorKey key = new SectorKey(showId, sectorId);
        SectorInfo cached = this.sectors.get(key);
        if (cached != null) {
            return Optional.of(cached);
        }
        Optional<SectorInfo> loaded = this.jdbc.sql("""
                SELECT name, kind FROM sectors WHERE show_id = :showId AND id = :sectorId
                """)
                .param("showId", showId)
                .param("sectorId", sectorId)
                .query((rs, row) -> new SectorInfo(showId, sectorId, rs.getString("name"),
                        SectorKind.valueOf(rs.getString("kind"))))
                .optional();
        loaded.ifPresent(sector -> this.sectors.putIfAbsent(key, sector));
        return loaded;
    }

    /** As cadeiras do setor, por rótulo, na ordem do mapa. */
    public Map<String, SeatInfo> seats(UUID showId, UUID sectorId) {
        SectorKey key = new SectorKey(showId, sectorId);
        Map<String, SeatInfo> cached = this.seats.get(key);
        if (cached != null) {
            return cached;
        }
        Map<String, SeatInfo> loaded = load(showId, sectorId);
        Map<String, SeatInfo> raced = this.seats.putIfAbsent(key, loaded);
        return raced != null ? raced : loaded;
    }

    public Optional<SeatInfo> seat(UUID showId, UUID sectorId, String label) {
        return Optional.ofNullable(seats(showId, sectorId).get(label));
    }

    /** Descarta o que estiver em memória sobre o show (a carga do estoque chama antes de carregar). */
    public void forget(UUID showId) {
        this.seats.keySet().removeIf(key -> key.showId().equals(showId));
        this.sectors.keySet().removeIf(key -> key.showId().equals(showId));
    }

    private Map<String, SeatInfo> load(UUID showId, UUID sectorId) {
        List<SeatInfo> found = new ArrayList<>(this.jdbc.sql("""
                SELECT id, label, position FROM seats WHERE show_id = :showId AND sector_id = :sectorId
                """)
                .param("showId", showId)
                .param("sectorId", sectorId)
                .query((rs, row) -> new SeatInfo(rs.getObject("id", UUID.class), rs.getString("label"),
                        rs.getInt("position")))
                .list());
        found.sort(Comparator.comparingInt(SeatInfo::position));
        Map<String, SeatInfo> byLabel = new LinkedHashMap<>();
        found.forEach(seat -> byLabel.put(seat.label(), seat));
        return Collections.unmodifiableMap(byLabel);
    }
}

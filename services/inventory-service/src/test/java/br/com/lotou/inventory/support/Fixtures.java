package br.com.lotou.inventory.support;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.catalog.CatalogShow.CatalogLot;
import br.com.lotou.inventory.catalog.CatalogShow.CatalogSector;
import br.com.lotou.inventory.catalog.CatalogShow.Row;
import br.com.lotou.inventory.catalog.CatalogSynchronizer;
import br.com.lotou.inventory.catalog.SectorKind;
import br.com.lotou.inventory.catalog.ShowStatus;
import br.com.lotou.inventory.lot.SalesLifecycle;
import br.com.lotou.inventory.reservation.CreateReservationRequest;
import br.com.lotou.inventory.shared.UuidV7;

import org.springframework.boot.test.context.TestComponent;
import org.springframework.jdbc.core.simple.JdbcClient;

/** Monta shows no inventory pelo mesmo caminho da produção: catálogo e abertura de vendas. */
@TestComponent
public class Fixtures {

    public static final String PRODUCER = "produtor-1";

    private final CatalogSynchronizer synchronizer;
    private final SalesLifecycle lifecycle;
    private final JdbcClient jdbc;
    private final Clock clock;

    public Fixtures(CatalogSynchronizer synchronizer, SalesLifecycle lifecycle, JdbcClient jdbc, Clock clock) {
        this.synchronizer = synchronizer;
        this.lifecycle = lifecycle;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** Um setor de pista com os lotes informados, na ordem de virada. */
    public static CatalogSector pista(CatalogLot... lots) {
        int capacity = List.of(lots).stream().mapToInt(CatalogLot::quantity).sum();
        return new CatalogSector(UuidV7.generate(), "Pista", SectorKind.GENERAL_ADMISSION, capacity, List.of(),
                List.of(lots));
    }

    /** Um setor de cadeira numerada com {@code rows} fileiras de {@code seatsPerRow} cadeiras (A, B, C...). */
    public static CatalogSector cadeiras(int rows, int seatsPerRow, long priceCents) {
        List<Row> layout = new ArrayList<>();
        for (int i = 0; i < rows; i++) {
            layout.add(new Row(String.valueOf((char) ('A' + i)), seatsPerRow));
        }
        int capacity = rows * seatsPerRow;
        return new CatalogSector(UuidV7.generate(), "Cadeira", SectorKind.RESERVED_SEATING, capacity, layout,
                List.of(lot("Lote único", priceCents, capacity)));
    }

    public static CatalogLot lot(String name, long priceCents, int quantity) {
        return new CatalogLot(UuidV7.generate(), name, priceCents, quantity, null);
    }

    public static CatalogLot lot(String name, long priceCents, int quantity, Instant opensAt) {
        return new CatalogLot(UuidV7.generate(), name, priceCents, quantity, opensAt);
    }

    /** Um show publicado, com as vendas marcadas para {@code salesStartAt}. */
    public CatalogShow show(Instant salesStartAt, CatalogSector... sectors) {
        Instant now = this.clock.instant();
        Instant startsAt = now.plus(Duration.ofDays(60));
        return new CatalogShow(UuidV7.generate(), PRODUCER, ShowStatus.PUBLISHED, 2, now, startsAt, salesStartAt,
                startsAt, false, List.of(sectors));
    }

    /** Aplica o show no inventory, como a leitura do catálogo faria. */
    public CatalogShow publish(CatalogShow show) {
        this.synchronizer.apply(show);
        return show;
    }

    /** Um show publicado e já com as vendas abertas. */
    public CatalogShow onSale(CatalogSector... sectors) {
        Instant now = this.clock.instant();
        CatalogShow show = publish(show(now.minusSeconds(60), sectors));
        this.lifecycle.openSales(show.id(), now);
        return show;
    }

    public static CreateReservationRequest pistaRequest(CatalogShow show, int quantity, String cpf) {
        return new CreateReservationRequest(show.id(), show.sectors().getFirst().id(), quantity, null, cpf);
    }

    public static CreateReservationRequest seatsRequest(CatalogShow show, UUID sectorId, String cpf, String... seats) {
        return new CreateReservationRequest(show.id(), sectorId, null, List.of(seats), cpf);
    }

    public int available(UUID lotId) {
        return this.jdbc.sql("SELECT available FROM lots WHERE id = :id").param("id", lotId).query(Integer.class)
                .single();
    }

    public String lotStatus(UUID lotId) {
        return this.jdbc.sql("SELECT status FROM lots WHERE id = :id").param("id", lotId).query(String.class)
                .single();
    }

    public String seatStatus(UUID showId, String label) {
        return this.jdbc.sql("SELECT status FROM seats WHERE show_id = :showId AND label = :label")
                .param("showId", showId).param("label", label).query(String.class).single();
    }

    /** Ingressos segurados ou vendidos no show: a soma das reservas HELD e CONFIRMED. */
    public int reservedTickets(UUID showId) {
        return this.jdbc.sql("""
                SELECT COALESCE(SUM(quantity), 0) FROM reservations
                WHERE show_id = :showId AND status IN ('HELD', 'CONFIRMED')
                """).param("showId", showId).query(Integer.class).single();
    }

    public int count(String sql, UUID showId) {
        return this.jdbc.sql(sql).param("showId", showId).query(Integer.class).single();
    }
}

package br.com.lotou.inventory.catalog;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import br.com.lotou.inventory.catalog.CatalogShow.CatalogLot;
import br.com.lotou.inventory.catalog.CatalogShow.CatalogSector;
import br.com.lotou.inventory.catalog.CatalogShow.Row;
import br.com.lotou.inventory.lot.LotStatus;
import br.com.lotou.inventory.seat.SeatStatus;
import br.com.lotou.inventory.shared.UuidV7;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Aplica um show do catálogo na cópia local: show, setores, lotes e cadeiras.
 *
 * <ul>
 *   <li>É idempotente: uma versão igual ou mais antiga que a gravada é ignorada, então reler o
 *       mesmo show não muda nada.
 *   <li>Enquanto as vendas não abriram, uma versão nova substitui setores, lotes e cadeiras
 *       inteiros (ainda não há reserva apontando para eles).
 *   <li>Depois que as vendas abrem, só os dados do show mudam (estado e datas). O event-service não
 *       aceita edição de setores e lotes de um show em venda.
 * </ul>
 */
@Component
public class CatalogSynchronizer {

    private record Local(int catalogVersion, Timestamp salesOpenedAt) {
    }

    private final JdbcClient jdbc;
    private final JdbcTemplate jdbcTemplate;
    private final Clock clock;

    public CatalogSynchronizer(JdbcClient jdbc, JdbcTemplate jdbcTemplate, Clock clock) {
        this.jdbc = jdbc;
        this.jdbcTemplate = jdbcTemplate;
        this.clock = clock;
    }

    @Transactional
    public void apply(CatalogShow show) {
        // FOR UPDATE: a abertura das vendas não corre junto com a troca dos lotes.
        Optional<Local> local = this.jdbc
                .sql("SELECT catalog_version, sales_opened_at FROM shows WHERE id = :id FOR UPDATE")
                .param("id", show.id())
                .query(Local.class)
                .optional();

        if (local.isEmpty()) {
            // Se outra instância inseriu primeiro, ela também grava a estrutura.
            if (insertShow(show)) {
                insertStructure(show);
            }
            return;
        }
        if (show.version() <= local.get().catalogVersion()) {
            return;
        }
        updateShow(show);
        if (local.get().salesOpenedAt() == null) {
            // Apaga setores, lotes e cadeiras em cascata e recria.
            this.jdbc.sql("DELETE FROM sectors WHERE show_id = :id").param("id", show.id()).update();
            insertStructure(show);
        }
    }

    private boolean insertShow(CatalogShow show) {
        return this.jdbc.sql("""
                INSERT INTO shows (id, producer_id, status, starts_at, sales_start_at, sales_end_at,
                                   high_demand, catalog_version, synced_at)
                VALUES (:id, :producerId, :status, :startsAt, :salesStartAt, :salesEndAt,
                        :highDemand, :version, :now)
                ON CONFLICT (id) DO NOTHING
                """)
                .param("id", show.id())
                .param("producerId", show.producerId())
                .param("status", show.status().name())
                .param("startsAt", timestamp(show.startsAt()))
                .param("salesStartAt", timestamp(show.salesStartAt()))
                .param("salesEndAt", timestamp(show.salesEndAt()))
                .param("highDemand", show.highDemand())
                .param("version", show.version())
                .param("now", timestamp(this.clock.instant()))
                .update() == 1;
    }

    private void updateShow(CatalogShow show) {
        this.jdbc.sql("""
                UPDATE shows
                SET status = :status, starts_at = :startsAt, sales_start_at = :salesStartAt,
                    sales_end_at = :salesEndAt, high_demand = :highDemand,
                    catalog_version = :version, synced_at = :now
                WHERE id = :id
                """)
                .param("id", show.id())
                .param("status", show.status().name())
                .param("startsAt", timestamp(show.startsAt()))
                .param("salesStartAt", timestamp(show.salesStartAt()))
                .param("salesEndAt", timestamp(show.salesEndAt()))
                .param("highDemand", show.highDemand())
                .param("version", show.version())
                .param("now", timestamp(this.clock.instant()))
                .update();
    }

    private void insertStructure(CatalogShow show) {
        List<Object[]> seats = new ArrayList<>();
        int sectorPosition = 0;
        for (CatalogSector sector : show.sectors()) {
            this.jdbc.sql("""
                    INSERT INTO sectors (show_id, id, name, kind, capacity, position)
                    VALUES (:showId, :id, :name, :kind, :capacity, :position)
                    """)
                    .param("showId", show.id())
                    .param("id", sector.id())
                    .param("name", sector.name())
                    .param("kind", sector.kind().name())
                    .param("capacity", sector.capacity())
                    .param("position", sectorPosition++)
                    .update();

            int lotPosition = 0;
            for (CatalogLot lot : sector.lots()) {
                this.jdbc.sql("""
                        INSERT INTO lots (id, show_id, sector_id, name, price_cents, quantity,
                                          available, position, opens_at, status)
                        VALUES (:id, :showId, :sectorId, :name, :priceCents, :quantity,
                                :quantity, :position, :opensAt, :status)
                        """)
                        .param("id", lot.id())
                        .param("showId", show.id())
                        .param("sectorId", sector.id())
                        .param("name", lot.name())
                        .param("priceCents", lot.priceCents())
                        .param("quantity", lot.quantity())
                        .param("position", lotPosition++)
                        .param("opensAt", timestamp(lot.opensAt()))
                        .param("status", LotStatus.SCHEDULED.name())
                        .update();
            }

            int seatPosition = 0;
            for (Row row : sector.rows() == null ? List.<Row>of() : sector.rows()) {
                for (int number = 1; number <= row.seatCount(); number++) {
                    seats.add(new Object[] {UuidV7.generate(), show.id(), sector.id(),
                            seatLabel(row.label(), number), seatPosition++, SeatStatus.AVAILABLE.name()});
                }
            }
        }
        // Um setor pode ter milhares de cadeiras: insere em lote.
        this.jdbcTemplate.batchUpdate("""
                INSERT INTO seats (id, show_id, sector_id, label, position, status)
                VALUES (?, ?, ?, ?, ?, ?)
                """, seats);
    }

    /** O rótulo de uma cadeira: fileira e número, ex.: {@code A-12}. */
    public static String seatLabel(String row, int number) {
        return row + "-" + number;
    }

    private static Timestamp timestamp(Instant instant) {
        return instant == null ? null : Timestamp.from(instant);
    }
}

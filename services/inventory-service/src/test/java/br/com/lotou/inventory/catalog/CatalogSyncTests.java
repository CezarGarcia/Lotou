package br.com.lotou.inventory.catalog;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow.CatalogSector;
import br.com.lotou.inventory.lot.SalesEngine;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.Contracts;
import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.MutableClock;
import br.com.lotou.inventory.support.TestKafka;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;

/** A cópia local do catálogo: como um show do event-service vira lotes e cadeiras no inventory. */
@IntegrationTest
class CatalogSyncTests {

    @Autowired
    private CatalogSynchronizer synchronizer;

    @Autowired
    private SalesEngine lifecycle;

    @Autowired
    private Fixtures fixtures;

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private MutableClock clock;

    private static CatalogShow version(CatalogShow show, int version, CatalogSector... sectors) {
        return new CatalogShow(show.id(), show.producerId(), show.status(), version, Instant.now(),
                show.startsAt(), show.salesStartAt(), show.salesEndAt(), true, List.of(sectors));
    }

    private List<String> lotNames(UUID showId) {
        return this.jdbc.sql("""
                SELECT l.name FROM lots l
                JOIN sectors s ON s.show_id = l.show_id AND s.id = l.sector_id
                WHERE l.show_id = :id
                ORDER BY s.position, l.position
                """).param("id", showId).query(String.class).list();
    }

    /** O show como o event-service o publica em shows.catalog (contracts/shows.catalog). */
    private static String message(String type, CatalogShow show) {
        var sectors = new StringBuilder();
        for (CatalogSector sector : show.sectors()) {
            var lots = new StringBuilder();
            for (var lot : sector.lots()) {
                lots.append(lots.isEmpty() ? "" : ",").append("""
                        {"id": "%s", "name": "%s", "priceCents": %d, "quantity": %d, "opensAt": null}
                        """.formatted(lot.id(), lot.name(), lot.priceCents(), lot.quantity()));
            }
            sectors.append(sectors.isEmpty() ? "" : ",").append("""
                    {"id": "%s", "name": "%s", "kind": "%s", "capacity": %d, "rows": [], "lots": [%s]}
                    """.formatted(sector.id(), sector.name(), sector.kind(), sector.capacity(), lots));
        }
        return """
                {"eventId": "%s", "type": "%s", "version": 1, "occurredAt": "%s", "payload": {
                 "showId": "%s", "version": %d, "producerId": "%s", "status": "%s", "title": "Show de teste",
                 "artist": "Artista de teste", "startsAt": "%s", "doorsOpenAt": null, "salesStartAt": "%s",
                 "salesEndAt": "%s", "highDemand": %s,
                 "venue": {"id": "%s", "name": "Local", "city": "Recife", "state": "PE", "timezone": "America/Recife"},
                 "sectors": [%s], "updatedAt": "%s", "serviceFeePaidBy": "BUYER"}}
                """.formatted(UUID.randomUUID(), type, show.updatedAt(), show.id(), show.version(),
                show.producerId(), show.status(), show.startsAt(), show.salesStartAt(), show.salesEndAt(),
                show.highDemand(), UUID.randomUUID(), sectors, show.updatedAt());
    }

    @Test
    void criaSetoresLotesAgendadosEUmaLinhaPorCadeira() {
        var setor = cadeiras(3, 4, 30_000);
        CatalogShow show = this.fixtures.publish(this.fixtures.show(this.clock.instant().plus(Duration.ofDays(1)),
                pista(lot("1º lote", 10_000, 100), lot("2º lote", 14_000, 50)), setor));

        assertThat(lotNames(show.id())).containsExactly("1º lote", "2º lote", "Lote único");
        assertThat(this.jdbc.sql("SELECT DISTINCT status FROM lots WHERE show_id = :id").param("id", show.id())
                .query(String.class).list()).containsExactly("SCHEDULED");
        assertThat(this.jdbc.sql("SELECT label FROM seats WHERE show_id = :id ORDER BY position")
                .param("id", show.id()).query(String.class).list())
                .containsExactly("A-1", "A-2", "A-3", "A-4", "B-1", "B-2", "B-3", "B-4", "C-1", "C-2", "C-3", "C-4");
        assertThat(this.fixtures.count("SELECT count(*) FROM seats WHERE show_id = :showId AND status = 'AVAILABLE'",
                show.id())).isEqualTo(12);
    }

    @Test
    void ignoraVersaoIgualOuMaisAntiga() {
        CatalogShow show = this.fixtures.publish(this.fixtures.show(this.clock.instant().plus(Duration.ofDays(1)),
                pista(lot("Original", 10_000, 100))));

        this.synchronizer.apply(version(show, show.version(), pista(lot("Mesma versão", 1, 1))));
        this.synchronizer.apply(version(show, show.version() - 1, pista(lot("Versão antiga", 1, 1))));

        assertThat(lotNames(show.id())).containsExactly("Original");
    }

    @Test
    void antesDaAberturaUmaVersaoNovaSubstituiLotesECadeiras() {
        CatalogShow show = this.fixtures.publish(this.fixtures.show(this.clock.instant().plus(Duration.ofDays(1)),
                pista(lot("Original", 10_000, 100)), cadeiras(2, 5, 30_000)));

        this.synchronizer.apply(version(show, show.version() + 1,
                pista(lot("1º lote", 12_000, 60), lot("2º lote", 15_000, 40)), cadeiras(1, 3, 30_000)));

        assertThat(lotNames(show.id())).containsExactly("1º lote", "2º lote", "Lote único");
        assertThat(this.fixtures.count("SELECT count(*) FROM seats WHERE show_id = :showId", show.id())).isEqualTo(3);
        assertThat(this.jdbc.sql("SELECT high_demand FROM shows WHERE id = :id").param("id", show.id())
                .query(Boolean.class).single()).isTrue();
    }

    @Test
    void depoisDaAberturaOsLotesNaoMudamMaisSoOsDadosDoShow() {
        var lote = lot("Original", 10_000, 100);
        CatalogShow show = this.fixtures.onSale(pista(lote));

        this.synchronizer.apply(new CatalogShow(show.id(), show.producerId(), ShowStatus.ON_SALE, show.version() + 1,
                Instant.now(), show.startsAt(), show.salesStartAt(), show.salesEndAt(), false,
                List.of(pista(lot("Intruso", 1, 1)))));

        assertThat(lotNames(show.id())).containsExactly("Original");
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("ON_SALE");
        assertThat(this.jdbc.sql("SELECT status FROM shows WHERE id = :id").param("id", show.id())
                .query(String.class).single()).isEqualTo("ON_SALE");
    }

    @Test
    void leOCatalogoDoTopicoEAplicaSoAVersaoMaisNova() {
        var sales = this.clock.instant().minusSeconds(60);
        CatalogShow show = at(this.fixtures.show(sales, pista(lot("Lote A", 10_000, 10))), Instant.now());
        // O show do fixture já está na cópia local; o tópico traz uma versão nova e uma antiga.
        CatalogShow newer = version(show, show.version() + 1, pista(lot("Lote novo", 15_000, 20)));
        CatalogShow older = version(show, show.version(), pista(lot("Lote velho", 1_000, 1)));
        String published = message("ShowUpdated", newer);
        Contracts.assertValid("shows.catalog", "ShowUpdated", published);

        TestKafka.send("shows.catalog", show.id().toString(), published);
        TestKafka.send("shows.catalog", show.id().toString(), message("ShowUpdated", older));

        Awaitility.await().atMost(Duration.ofSeconds(15))
                .until(() -> lotNames(show.id()).equals(List.of("Lote novo")));
        // Com as vendas abertas pelo ciclo normal, o show lido do tópico vende.
        assertThat(this.lifecycle.openSales(show.id(), this.clock.instant())).isTrue();
    }

    @Test
    void mensagemIlegivelNoCatalogoNaoParaALeitura() {
        TestKafka.send("shows.catalog", UUID.randomUUID().toString(), "{ isto não é um show");
        CatalogShow fresh = this.fixtures.show(this.clock.instant().plusSeconds(3600),
                pista(lot("Lote depois do lixo", 10_000, 10)));
        CatalogShow next = version(at(fresh, Instant.now()), fresh.version() + 1,
                pista(lot("Lote seguinte", 11_000, 10)));
        TestKafka.send("shows.catalog", fresh.id().toString(), message("ShowPublished", next));
        Awaitility.await().atMost(Duration.ofSeconds(30))
                .until(() -> lotNames(fresh.id()).equals(List.of("Lote seguinte")));
    }

    private static CatalogShow at(CatalogShow show, Instant updatedAt) {
        return new CatalogShow(show.id(), show.producerId(), show.status(), show.version(), updatedAt,
                show.startsAt().truncatedTo(ChronoUnit.MILLIS), show.salesStartAt().truncatedTo(ChronoUnit.MILLIS),
                show.salesEndAt().truncatedTo(ChronoUnit.MILLIS), show.highDemand(), show.sectors());
    }
}

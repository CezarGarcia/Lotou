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
import java.util.concurrent.atomic.AtomicReference;

import br.com.lotou.inventory.catalog.CatalogShow.CatalogSector;
import br.com.lotou.inventory.lot.SalesLifecycle;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.HttpStub;
import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.MutableClock;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** A cópia local do catálogo: como um show do event-service vira lotes e cadeiras no inventory. */
@IntegrationTest
class CatalogSyncTests {

    private static final String CATALOG = "/internal/v1/catalog/shows";
    private static final String TOKEN = "/token";

    /** O que o event-service de mentira devolve para cada página pedida. */
    private static final AtomicReference<java.util.function.Function<HttpStub.Received, String>> catalog =
            new AtomicReference<>(request -> "{\"items\": [], \"nextCursor\": null}");

    private static final HttpStub stub = HttpStub.start()
            .on(TOKEN, request -> "{\"access_token\": \"token-do-servico\", \"token_type\": \"Bearer\", \"expires_in\": 300}")
            .on(CATALOG, request -> catalog.get().apply(request));

    @Autowired
    private CatalogSynchronizer synchronizer;

    @Autowired
    private CatalogSyncJob job;

    @Autowired
    private SalesLifecycle lifecycle;

    @Autowired
    private Fixtures fixtures;

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private MutableClock clock;

    @DynamicPropertySource
    static void neighbours(DynamicPropertyRegistry registry) {
        registry.add("EVENT_SERVICE_URL", stub::url);
        registry.add("AUTH_TOKEN_URI", () -> stub.url() + TOKEN);
    }

    @AfterAll
    static void stopStub() {
        stub.close();
    }

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

    private static String json(CatalogShow show) {
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
                {"id": "%s", "producerId": "%s", "status": "%s", "version": %d, "updatedAt": "%s",
                 "startsAt": "%s", "salesStartAt": "%s", "salesEndAt": "%s", "highDemand": %s,
                 "sectors": [%s], "campoNovoQueOInventoryNaoConhece": true}
                """.formatted(show.id(), show.producerId(), show.status(), show.version(), show.updatedAt(),
                show.startsAt(), show.salesStartAt(), show.salesEndAt(), show.highDemand(), sectors);
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
    void leOCatalogoPaginadoComOTokenDaContaDeServicoEContinuaDeOndeParou() {
        Instant base = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        var sales = this.clock.instant().minusSeconds(60);
        CatalogShow first = at(this.fixtures.show(sales, pista(lot("Lote A", 10_000, 10))), base.minusSeconds(30));
        CatalogShow second = at(this.fixtures.show(sales, pista(lot("Lote B", 20_000, 20))), base.minusSeconds(20));
        catalog.set(request -> request.query().contains("cursor=pagina-2")
                ? "{\"items\": [%s], \"nextCursor\": null}".formatted(json(second))
                : "{\"items\": [%s], \"nextCursor\": \"pagina-2\"}".formatted(json(first)));
        stub.clear();

        assertThat(this.job.sync()).isEqualTo(2);

        assertThat(lotNames(first.id())).containsExactly("Lote A");
        assertThat(lotNames(second.id())).containsExactly("Lote B");
        assertThat(stub.requests(CATALOG)).hasSize(2)
                .allSatisfy(request -> assertThat(request.authorization()).isEqualTo("Bearer token-do-servico"));
        assertThat(stub.requests(CATALOG).get(1).query()).contains("cursor=pagina-2");

        // A leitura seguinte pede só o que mudou depois do último show lido, com uma folga.
        catalog.set(request -> "{\"items\": [], \"nextCursor\": null}");
        stub.clear();
        assertThat(this.job.sync()).isZero();
        assertThat(stub.requests(CATALOG).getFirst().query())
                .contains("updatedAfter=" + second.updatedAt().minusSeconds(5));
        // O token foi buscado uma vez e reaproveitado.
        assertThat(stub.requests(TOKEN)).hasSizeLessThanOrEqualTo(1);

        // Com as vendas abertas pelo ciclo normal, o show lido pelo catálogo vende.
        assertThat(this.lifecycle.openSales(first.id(), this.clock.instant())).isTrue();
    }

    private static CatalogShow at(CatalogShow show, Instant updatedAt) {
        return new CatalogShow(show.id(), show.producerId(), show.status(), show.version(), updatedAt,
                show.startsAt().truncatedTo(ChronoUnit.MILLIS), show.salesStartAt().truncatedTo(ChronoUnit.MILLIS),
                show.salesEndAt().truncatedTo(ChronoUnit.MILLIS), show.highDemand(), show.sectors());
    }
}

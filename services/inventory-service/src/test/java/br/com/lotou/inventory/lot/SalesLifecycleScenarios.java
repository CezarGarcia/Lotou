package br.com.lotou.inventory.lot;

import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static br.com.lotou.inventory.support.Fixtures.pistaRequest;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.catalog.CatalogSynchronizer;
import br.com.lotou.inventory.catalog.ShowStatus;
import br.com.lotou.inventory.reservation.ReservationService;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.support.Concurrently;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.MutableClock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.web.servlet.MockMvc;

/** Abertura das vendas, virada de lote por data, encerramento e pausa. */
abstract class SalesLifecycleScenarios {

    @Autowired
    private SalesLifecycleJob job;

    @Autowired
    private ReservationService reservations;

    @Autowired
    private CatalogSynchronizer synchronizer;

    @Autowired
    private Fixtures fixtures;

    @Autowired
    private MutableClock clock;

    @Autowired
    private MockMvc mvc;

    @AfterEach
    void resetClock() {
        this.clock.reset();
    }

    private void reserve(CatalogShow show, int quantity) {
        this.reservations.reserve("comprador-" + UUID.randomUUID(), UUID.randomUUID().toString(),
                pistaRequest(show, quantity, Cpfs.next()));
    }

    private static CatalogShow withStatus(CatalogShow show, ShowStatus status) {
        return new CatalogShow(show.id(), show.producerId(), status, show.version() + 1, Instant.now(),
                show.startsAt(), show.salesStartAt(), show.salesEndAt(), show.highDemand(), show.sectors());
    }

    @Test
    void asVendasAbremNoHorarioMarcadoESoOPrimeiroLoteEntraEmVenda() {
        var primeiro = lot("1º lote", 10_000, 5);
        var segundo = lot("2º lote", 14_000, 5);
        CatalogShow show = this.fixtures.publish(this.fixtures.show(this.clock.instant().plus(Duration.ofHours(2)),
                pista(primeiro, segundo)));

        this.job.run();
        assertThat(this.fixtures.lotStatus(primeiro.id())).isEqualTo("SCHEDULED");

        this.clock.advance(Duration.ofHours(2).plusSeconds(1));
        this.job.run();
        this.job.run(); // rodar de novo não muda nada

        assertThat(this.fixtures.lotStatus(primeiro.id())).isEqualTo("ON_SALE");
        assertThat(this.fixtures.lotStatus(segundo.id())).isEqualTo("SCHEDULED");
        reserve(show, 1);
    }

    @Test
    void variasInstanciasDoJobAbremAsVendasUmaVezSo() {
        var lote = lot("Lote único", 10_000, 5);
        this.fixtures.publish(this.fixtures.show(this.clock.instant().minusSeconds(5), pista(lote)));

        var results = Concurrently.run(8, i -> {
            this.job.run();
            return true;
        });

        assertThat(results).allMatch(Concurrently.Result::succeeded);
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("ON_SALE");
        assertThat(this.fixtures.available(lote.id())).isEqualTo(5);
    }

    @Test
    void loteViraNaDataMarcadaELevaOQueSobrou() {
        var primeiro = lot("1º lote", 10_000, 10);
        var segundo = lot("2º lote", 14_000, 10, this.clock.instant().plus(Duration.ofDays(7)));
        CatalogShow show = this.fixtures.onSale(pista(primeiro, segundo));
        reserve(show, 4);

        this.job.run();
        assertThat(this.fixtures.lotStatus(segundo.id())).isEqualTo("SCHEDULED");

        this.clock.advance(Duration.ofDays(7).plusSeconds(1));
        this.job.run();

        assertThat(this.fixtures.lotStatus(primeiro.id())).isEqualTo("SOLD_OUT");
        assertThat(this.fixtures.available(primeiro.id())).isZero();
        assertThat(this.fixtures.lotStatus(segundo.id())).isEqualTo("ON_SALE");
        assertThat(this.fixtures.available(segundo.id())).isEqualTo(16);
    }

    @Test
    void asVendasEncerramNoHorarioMarcado() {
        var lote = lot("Lote único", 10_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));

        this.clock.advance(Duration.ofDays(61));
        this.job.run();

        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("CLOSED");
        assertThatThrownBy(() -> reserve(show, 1))
                .satisfies(e -> assertThat(((ProblemException) e).slug()).isEqualTo("sales-closed"));
    }

    @Test
    void showCanceladoParaDeVender() {
        var lote = lot("Lote único", 10_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));

        this.synchronizer.apply(withStatus(show, ShowStatus.CANCELLED));
        this.job.run();

        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("CLOSED");
    }

    @Test
    void showQueNaoEstaMaisAVendaNaoAbre() {
        var lote = lot("Lote único", 10_000, 10);
        CatalogShow show = this.fixtures.publish(this.fixtures.show(this.clock.instant().minusSeconds(5), pista(lote)));
        this.synchronizer.apply(withStatus(show, ShowStatus.CANCELLED));

        this.job.run();

        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("SCHEDULED");
    }

    @Test
    void produtorPausaERetomaOLoteDoSeuShow() throws Exception {
        var lote = lot("Lote único", 10_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        var owner = jwt().jwt(token -> token.subject(Fixtures.PRODUCER))
                .authorities(new SimpleGrantedAuthority("ROLE_producer"));
        var other = jwt().jwt(token -> token.subject("outro-produtor"))
                .authorities(new SimpleGrantedAuthority("ROLE_producer"));

        this.mvc.perform(post("/v1/lots/%s/pause".formatted(lote.id())).with(other)).andExpect(status().isNotFound());
        this.mvc.perform(post("/v1/lots/%s/pause".formatted(lote.id())).with(owner))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("PAUSED"));
        assertThatThrownBy(() -> reserve(show, 1))
                .satisfies(e -> assertThat(((ProblemException) e).slug()).isEqualTo("sales-paused"));

        // Pausar de novo não está na tabela de transições.
        this.mvc.perform(post("/v1/lots/%s/pause".formatted(lote.id())).with(owner))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:invalid-state-transition"));

        this.mvc.perform(post("/v1/lots/%s/resume".formatted(lote.id())).with(owner))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("ON_SALE"));
        reserve(show, 1);
        assertThat(List.of(this.fixtures.available(lote.id()))).containsExactly(9);
    }
}

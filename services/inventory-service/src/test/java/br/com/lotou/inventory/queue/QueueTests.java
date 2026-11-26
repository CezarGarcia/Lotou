package br.com.lotou.inventory.queue;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static br.com.lotou.inventory.support.Fixtures.pistaRequest;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;
import static org.springframework.security.test.web.servlet.request.SecurityMockMvcRequestPostProcessors.jwt;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.stream.IntStream;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.lot.SalesEngine;
import br.com.lotou.inventory.queue.QueueStatus.State;
import br.com.lotou.inventory.reservation.ReservationService;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.support.Concurrently;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.MutableClock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/** Fila virtual dos shows de alta demanda: sala de espera, sorteio, admissão e posição ao vivo. */
@IntegrationTest
@TestPropertySource(properties = {
        "lotou.inventory.queue.admission-rate=3",
        "lotou.inventory.queue.admission-ttl=2s" })
class QueueTests {

    @Autowired
    private QueueService queue;

    @Autowired
    private QueueAdmissionJob admission;

    @Autowired
    private ReservationService reservations;

    @Autowired
    private SalesEngine sales;

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

    /** Um show de alta demanda publicado, com as vendas daqui a {@code salesIn}. */
    private CatalogShow highDemand(Duration salesIn) {
        CatalogShow show = this.fixtures.show(this.clock.instant().plus(salesIn), pista(lot("Pista", 15_000, 500)));
        return this.fixtures.publish(new CatalogShow(show.id(), show.producerId(), show.status(), show.version(),
                show.updatedAt(), show.startsAt(), show.salesStartAt(), show.salesEndAt(), true, show.sectors()));
    }

    /** Adianta o relógio até a abertura e abre as vendas, como o job faria. */
    private void openSales(CatalogShow show) {
        this.clock.advance(Duration.between(this.clock.instant(), show.salesStartAt()).plusSeconds(1));
        this.sales.openSales(show.id(), this.clock.instant());
    }

    private void reserve(CatalogShow show, String buyer) {
        this.reservations.reserve(buyer, UUID.randomUUID().toString(), pistaRequest(show, 1, Cpfs.next()));
    }

    private static String slugOf(Throwable error) {
        return ((ProblemException) error).slug();
    }

    @Test
    void showSemAltaDemandaNaoTemFila() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Pista", 10_000, 10)));

        assertThat(this.queue.join(show.id(), "ana").status()).isEqualTo(State.NOT_REQUIRED);
        reserve(show, "ana");
    }

    @Test
    void aSalaDeEsperaAbreTrintaMinutosAntesDasVendas() {
        CatalogShow show = highDemand(Duration.ofHours(2));

        QueueStatus early = this.queue.join(show.id(), "ana");
        assertThat(early.status()).isEqualTo(State.NOT_OPEN);
        assertThat(early.waitingRoomOpensAt()).isCloseTo(show.salesStartAt().minus(Duration.ofMinutes(30)),
                org.assertj.core.api.Assertions.within(1, java.time.temporal.ChronoUnit.MILLIS));

        this.clock.advance(Duration.ofMinutes(95));
        assertThat(this.queue.join(show.id(), "ana").status()).isEqualTo(State.WAITING_ROOM);
        assertThat(this.queue.status(show.id(), "ana").status()).isEqualTo(State.WAITING_ROOM);
        assertThat(this.queue.status(show.id(), "bia").status()).isEqualTo(State.NOT_IN_QUEUE);
    }

    @Test
    void naAberturaASalaEhSorteadaEFicaAFrenteDeQuemChegaDepois() {
        CatalogShow show = highDemand(Duration.ofMinutes(10));
        List<String> room = IntStream.range(0, 30).mapToObj(i -> "sala-" + i).toList();
        room.forEach(user -> this.queue.join(show.id(), user));

        openSales(show);
        this.queue.join(show.id(), "atrasada");
        this.admission.drawIfNeeded(show.id());
        this.admission.drawIfNeeded(show.id()); // sortear de novo não muda nada
        this.queue.join(show.id(), "mais-atrasada");

        List<Long> positions = room.stream().map(user -> this.queue.status(show.id(), user).position()).toList();
        assertThat(positions).containsExactlyInAnyOrderElementsOf(
                IntStream.rangeClosed(1, 30).mapToObj(Long::valueOf).toList());
        // O sorteio embaralha: a ordem de chegada na sala não é a ordem da fila.
        assertThat(positions).isNotEqualTo(IntStream.rangeClosed(1, 30).mapToObj(Long::valueOf).toList());
        assertThat(this.queue.status(show.id(), "atrasada").position()).isEqualTo(31);
        assertThat(this.queue.status(show.id(), "mais-atrasada").position()).isEqualTo(32);
    }

    @Test
    void soReservaQuemFoiAdmitidoEAAdmissaoVencePassadoOPrazo() {
        CatalogShow show = highDemand(Duration.ofMinutes(10));
        openSales(show);
        this.admission.drawIfNeeded(show.id());
        List<String> buyers = IntStream.range(0, 5).mapToObj(i -> "comprador-" + i).toList();
        buyers.forEach(buyer -> this.queue.join(show.id(), buyer));

        assertThatThrownBy(() -> reserve(show, "comprador-0"))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("queue-admission-required"));

        // Admite 3 por rodada (lotou.inventory.queue.admission-rate=3), uma rodada por segundo.
        assertThat(this.admission.admitNext(show.id())).isEqualTo(3);
        QueueStatus admitted = this.queue.status(show.id(), "comprador-0");
        assertThat(admitted.status()).isEqualTo(State.ADMITTED);
        assertThat(admitted.admittedUntil()).isAfter(this.clock.instant());
        QueueStatus waiting = this.queue.status(show.id(), "comprador-3");
        assertThat(waiting.status()).isEqualTo(State.QUEUED);
        assertThat(waiting.position()).isEqualTo(1);
        assertThat(waiting.estimatedWaitSeconds()).isEqualTo(1);

        reserve(show, "comprador-0");
        assertThatThrownBy(() -> reserve(show, "comprador-3"))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("queue-admission-required"));

        // O token dura 2 s neste teste: quem não reserva no prazo perde a vez e volta ao fim da fila.
        await().atMost(Duration.ofSeconds(5)).until(() ->
                this.queue.status(show.id(), "comprador-1").status() == State.NOT_IN_QUEUE);
        assertThatThrownBy(() -> reserve(show, "comprador-1"))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("queue-admission-required"));
        assertThat(this.queue.join(show.id(), "comprador-1").position()).isEqualTo(3);
    }

    @Test
    void trezentasEntradasSimultaneasRecebemPosicoesUnicas() {
        CatalogShow show = highDemand(Duration.ofMinutes(10));
        openSales(show);
        this.admission.drawIfNeeded(show.id());

        var results = Concurrently.run(300, i -> this.queue.join(show.id(), "pessoa-" + i));

        assertThat(results).allMatch(Concurrently.Result::succeeded);
        assertThat(results).allSatisfy(result -> assertThat(result.value().status()).isEqualTo(State.QUEUED));
        // A posição devolvida na entrada é a daquele instante; depois que todos entram, cada um tem a sua.
        assertThat(IntStream.range(0, 300).mapToObj(i -> this.queue.status(show.id(), "pessoa-" + i).position()))
                .containsExactlyInAnyOrderElementsOf(IntStream.rangeClosed(1, 300).mapToObj(Long::valueOf).toList());
        // Entrar de novo não muda a posição.
        long before = this.queue.status(show.id(), "pessoa-7").position();
        assertThat(this.queue.join(show.id(), "pessoa-7").position()).isEqualTo(before);
    }

    @Test
    void aPosicaoChegaAoVivoPorSseAteAAdmissao() throws Exception {
        CatalogShow show = highDemand(Duration.ofMinutes(10));
        openSales(show);
        this.admission.drawIfNeeded(show.id());
        this.queue.join(show.id(), "ana");
        this.queue.join(show.id(), "bia");
        this.queue.join(show.id(), "caio");
        this.queue.join(show.id(), "duda");

        MvcResult stream = this.mvc.perform(get("/v1/queue/%s/events".formatted(show.id()))
                .with(jwt().jwt(token -> token.subject("duda")).authorities(new SimpleGrantedAuthority("ROLE_buyer"))))
                .andExpect(request().asyncStarted())
                .andReturn();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(stream.getResponse().getContentAsString())
                .contains("event:status").contains("\"status\":\"QUEUED\"").contains("\"position\":4"));

        this.admission.admitNext(show.id());
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(stream.getResponse().getContentAsString())
                .contains("\"position\":1"));
        // Uma admissão por segundo: o lock da rodada anterior precisa vencer.
        await().atMost(Duration.ofSeconds(3)).until(() -> this.admission.admitNext(show.id()) > 0);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(stream.getResponse().getContentAsString())
                .contains("\"status\":\"ADMITTED\"").contains("admittedUntil"));
    }

    @Test
    void oMapaDeAssentosChegaAoVivoPorSse() throws Exception {
        var setor = cadeiras(2, 5, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);

        MvcResult stream = this.mvc.perform(get("/v1/availability/%s/sectors/%s/seats/events".formatted(show.id(),
                setor.id())))
                .andExpect(request().asyncStarted())
                .andReturn();
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(stream.getResponse().getContentAsString())
                .contains("event:snapshot").contains("\"label\":\"B-5\""));

        this.reservations.reserve("ana", UUID.randomUUID().toString(),
                br.com.lotou.inventory.support.Fixtures.seatsRequest(show, setor.id(), Cpfs.next(), "A-2", "A-3"));
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(stream.getResponse().getContentAsString())
                .contains("event:seats").contains("\"seats\":[\"A-2\",\"A-3\"]").contains("\"available\":false"));

    }
}

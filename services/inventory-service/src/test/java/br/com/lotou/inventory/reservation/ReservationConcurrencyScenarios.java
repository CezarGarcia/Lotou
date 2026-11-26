package br.com.lotou.inventory.reservation;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static br.com.lotou.inventory.support.Fixtures.pistaRequest;
import static br.com.lotou.inventory.support.Fixtures.seatsRequest;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.support.Concurrently;
import br.com.lotou.inventory.support.Concurrently.Result;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;

/**
 * As invariantes do sistema sob disputa: nunca vender além da capacidade e nunca segurar a mesma
 * cadeira duas vezes. Cada teste dispara as reservas no mesmo instante, contra um Postgres real.
 */
abstract class ReservationConcurrencyScenarios {

    @Autowired
    private ReservationService service;

    @Autowired
    private Fixtures fixtures;

    private ReservationView reserve(CreateReservationRequest request) {
        return this.service.reserve("comprador-" + UUID.randomUUID(), UUID.randomUUID().toString(), request)
                .reservation();
    }

    private static List<String> problems(List<? extends Result<?>> results) {
        return results.stream()
                .filter(result -> !result.succeeded())
                .map(result -> result.error() instanceof ProblemException problem ? problem.slug()
                        : result.error().toString())
                .toList();
    }

    @Test
    void duzentosCompradoresDisputamCinquentaIngressosENinguemVendeAMais() {
        var lote = lot("Lote único", 12_000, 50);
        CatalogShow show = this.fixtures.onSale(pista(lote));

        var results = Concurrently.run(200, i -> reserve(pistaRequest(show, 1, Cpfs.next())));

        assertThat(results.stream().filter(Result::succeeded)).hasSize(50);
        assertThat(problems(results)).hasSize(150).containsOnly("sold-out");
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(50);
        assertThat(this.fixtures.available(lote.id())).isZero();
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("SOLD_OUT");
    }

    @Test
    void reservasDeTamanhosDiferentesNuncaPassamDaCapacidadeEViramOLote() {
        var primeiro = lot("1º lote", 10_000, 30);
        var segundo = lot("2º lote", 14_000, 20);
        CatalogShow show = this.fixtures.onSale(pista(primeiro, segundo));

        var results = Concurrently.run(120, i -> reserve(pistaRequest(show, 1 + i % 4, Cpfs.next())));

        List<ReservationView> reserved = results.stream().filter(Result::succeeded).map(Result::value).toList();
        int tickets = reserved.stream().mapToInt(ReservationView::quantity).sum();
        assertThat(tickets).isLessThanOrEqualTo(50);
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(tickets);
        // O que foi reservado mais o que sobrou nos contadores é sempre a capacidade.
        assertThat(tickets + this.fixtures.available(primeiro.id()) + this.fixtures.available(segundo.id()))
                .isEqualTo(50);
        assertThat(problems(results)).isSubsetOf("sold-out", "insufficient-stock");

        // Cada reserva saiu de um lote só, ao preço dele.
        for (ReservationView reservation : reserved) {
            long price = reservation.items().getFirst().unitPriceCents();
            assertThat(price).isIn(10_000L, 14_000L);
            assertThat(reservation.totalCents()).isEqualTo(price * reservation.quantity());
            assertThat(reservation.items()).allMatch(item -> item.unitPriceCents() == price);
        }
        // O segundo lote só abre depois que o primeiro esgota.
        long doSegundo = reserved.stream()
                .filter(r -> r.items().getFirst().unitPriceCents() == 14_000L).count();
        if (doSegundo > 0) {
            assertThat(this.fixtures.lotStatus(primeiro.id())).isEqualTo("SOLD_OUT");
        }
    }

    @Test
    void cemCompradoresDisputamAsMesmasCadeirasESoUmLeva() {
        var setor = cadeiras(2, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);

        var results = Concurrently.run(100,
                i -> reserve(seatsRequest(show, setor.id(), Cpfs.next(), "A-1", "A-2", "A-3", "A-4")));

        assertThat(results.stream().filter(Result::succeeded)).hasSize(1);
        assertThat(problems(results)).hasSize(99).containsOnly("seat-unavailable");
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(4);
        assertThat(this.fixtures.count("SELECT count(*) FROM seats WHERE show_id = :showId AND status = 'HELD'",
                show.id())).isEqualTo(4);
        // Quem perdeu não ficou com nada: o contador do lote só desceu pelas 4 cadeiras.
        assertThat(this.fixtures.available(setor.lots().getFirst().id())).isEqualTo(16);
    }

    @Test
    void reservaDeCadeirasEhTudoOuNada() {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);
        reserve(seatsRequest(show, setor.id(), Cpfs.next(), "A-3"));

        // Pedidos que se sobrepõem em ordens diferentes: sem deadlock e sem reserva pela metade.
        var results = Concurrently.run(40, i -> reserve(i % 2 == 0
                ? seatsRequest(show, setor.id(), Cpfs.next(), "A-1", "A-2", "A-3")
                : seatsRequest(show, setor.id(), Cpfs.next(), "A-3", "A-2", "A-1")));

        assertThat(results.stream().filter(Result::succeeded)).isEmpty();
        assertThat(problems(results)).containsOnly("seat-unavailable");
        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("AVAILABLE");
        assertThat(this.fixtures.seatStatus(show.id(), "A-2")).isEqualTo("AVAILABLE");
        assertThat(this.fixtures.seatStatus(show.id(), "A-3")).isEqualTo("HELD");
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(1);
    }

    @Test
    void cadeirasDiferentesNaoSeAtrapalham() {
        var setor = cadeiras(4, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);

        var results = Concurrently.run(40, i -> reserve(seatsRequest(show, setor.id(), Cpfs.next(),
                (char) ('A' + i / 10) + "-" + (1 + i % 10))));

        assertThat(problems(results)).isEmpty();
        assertThat(this.fixtures.count("SELECT count(*) FROM seats WHERE show_id = :showId AND status = 'HELD'",
                show.id())).isEqualTo(40);
        assertThat(this.fixtures.lotStatus(setor.lots().getFirst().id())).isEqualTo("SOLD_OUT");
    }

    @Test
    void mesmoCpfNuncaPassaDeQuatroIngressosMesmoComPedidosSimultaneos() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 500)));
        String cpf = Cpfs.next();

        var results = Concurrently.run(30, i -> reserve(pistaRequest(show, 1, cpf)));

        assertThat(results.stream().filter(Result::succeeded)).hasSize(4);
        assertThat(problems(results)).hasSize(26).containsOnly("purchase-limit-exceeded");
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(4);
    }

    @Test
    void mesmaIdempotencyKeyReservaUmaVezSo() {
        var lote = lot("Lote único", 12_000, 100);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        String buyer = "comprador-" + UUID.randomUUID();
        String key = UUID.randomUUID().toString();
        CreateReservationRequest request = pistaRequest(show, 2, Cpfs.next());

        var results = Concurrently.run(20, i -> this.service.reserve(buyer, key, request));

        assertThat(problems(results)).isEmpty();
        assertThat(results.stream().map(r -> r.value().reservation().id()).distinct()).hasSize(1);
        assertThat(results.stream().filter(r -> !r.value().replayed())).hasSize(1);
        assertThat(this.fixtures.available(lote.id())).isEqualTo(98);
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(2);
    }
}

package br.com.lotou.inventory.reservation;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static br.com.lotou.inventory.support.Fixtures.pistaRequest;
import static br.com.lotou.inventory.support.Fixtures.seatsRequest;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.lot.SalesEngine;
import br.com.lotou.inventory.lot.SalesEngine.SeatAvailability;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.support.Concurrently;
import br.com.lotou.inventory.support.Concurrently.Result;
import br.com.lotou.inventory.support.Contracts;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.MutableClock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * Devolução dos ingressos de uma reserva confirmada (pedido cancelado e reembolsado, comando
 * ReturnTickets): o estoque volta ao lote em venda, as cadeiras e a cota do CPF ficam livres e o
 * fato ReservationReturned sai pelo outbox. Roda contra os dois motores.
 */
abstract class ReservationReturnScenarios {

    @Autowired
    protected ReservationService service;

    @Autowired
    protected SalesEngine sales;

    @Autowired
    protected Fixtures fixtures;

    @Autowired
    protected MutableClock clock;

    @Autowired
    protected JdbcClient jdbc;

    @Autowired
    private JsonMapper json;

    @AfterEach
    void resetClock() {
        this.clock.reset();
    }

    protected ReservationView reserve(CreateReservationRequest request) {
        return this.service.reserve("comprador-" + UUID.randomUUID(), UUID.randomUUID().toString(), request)
                .reservation();
    }

    /** Uma reserva já paga. */
    protected ReservationView sold(CreateReservationRequest request) {
        ReservationView reservation = reserve(request);
        this.service.confirm(reservation.id());
        return reservation;
    }

    protected static String slugOf(Throwable error) {
        return ((ProblemException) error).slug();
    }

    protected ReservationStatus statusOf(UUID reservationId) {
        return this.service.get(reservationId).reservation().status();
    }

    /** Os fatos sobre a reserva no outbox, em ordem. */
    protected List<String> factsAbout(UUID reservationId) {
        this.fixtures.settle();
        return this.jdbc.sql("""
                SELECT type FROM outbox WHERE envelope -> 'payload' ->> 'reservationId' = :id ORDER BY id
                """).param("id", reservationId.toString()).query(String.class).list();
    }

    /** O ReservationReturned da reserva, conferido contra o contrato. */
    protected JsonNode returnedFact(UUID reservationId) {
        this.fixtures.settle();
        String envelope = this.jdbc.sql("""
                SELECT envelope::text FROM outbox
                WHERE type = 'ReservationReturned' AND envelope -> 'payload' ->> 'reservationId' = :id
                """).param("id", reservationId.toString()).query(String.class).single();
        Contracts.assertValid("inventory.events", "ReservationReturned", envelope);
        return this.json.readTree(envelope);
    }

    protected int cpfQuota(UUID showId) {
        return this.fixtures.count("SELECT COALESCE(SUM(quantity), 0) FROM purchase_limits WHERE show_id = :showId",
                showId);
    }

    protected boolean seatFree(CatalogShow show, UUID sectorId, String label) {
        return this.sales.seats(show.id(), sectorId).stream()
                .filter(seat -> seat.label().equals(label))
                .findFirst()
                .map(SeatAvailability::available)
                .orElseThrow();
    }

    /** As vendas do show encerram no horário marcado (o fim da janela é o início do show, em 60 dias). */
    protected void closeSales(CatalogShow show) {
        this.clock.advance(Duration.ofDays(61));
        assertThat(this.sales.closeSales(show.id(), this.clock.instant())).isTrue();
    }

    @Test
    void pistaDevolvidaVoltaAoLoteELiberaACotaDoCpf() {
        var lote = lot("Lote único", 15_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        String cpf = Cpfs.next();
        ReservationView reservation = sold(pistaRequest(show, 4, cpf));
        assertThatThrownBy(() -> reserve(pistaRequest(show, 1, cpf)))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("purchase-limit-exceeded"));

        ReservationView returned = this.service.returnTickets(reservation.id()).reservation();

        assertThat(returned.status()).isEqualTo(ReservationStatus.RETURNED);
        assertThat(this.fixtures.available(lote.id())).isEqualTo(10);
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("ON_SALE");
        assertThat(this.fixtures.reservedTickets(show.id())).isZero();
        JsonNode fact = returnedFact(reservation.id());
        assertThat(fact.get("payload").get("quantity").asInt()).isEqualTo(4);
        assertThat(fact.get("payload").get("lotId").asString()).isEqualTo(lote.id().toString());
        assertThat(fact.get("payload").get("seats").isEmpty()).isTrue();
        // A cota voltou: o mesmo CPF compra 4 de novo.
        assertThat(reserve(pistaRequest(show, 4, cpf)).quantity()).isEqualTo(4);
    }

    @Test
    void cadeiraDevolvidaFicaLivreNoMapaEPodeSerVendidaDeNovo() {
        var setor = cadeiras(1, 6, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);
        ReservationView reservation = sold(seatsRequest(show, setor.id(), Cpfs.next(), "A-2", "A-3"));
        assertThat(seatFree(show, setor.id(), "A-2")).isFalse();

        this.service.returnTickets(reservation.id());

        assertThat(this.fixtures.seatStatus(show.id(), "A-2")).isEqualTo("AVAILABLE");
        assertThat(this.fixtures.seatStatus(show.id(), "A-3")).isEqualTo("AVAILABLE");
        assertThat(seatFree(show, setor.id(), "A-2")).isTrue();
        assertThat(seatFree(show, setor.id(), "A-3")).isTrue();
        assertThat(this.fixtures.available(setor.lots().getFirst().id())).isEqualTo(6);
        assertThat(returnedFact(reservation.id()).get("payload").get("seats").valueStream()
                .map(JsonNode::asString).toList()).containsExactly("A-2", "A-3");

        ReservationView again = sold(seatsRequest(show, setor.id(), Cpfs.next(), "A-2"));
        assertThat(again.items().getFirst().seat()).isEqualTo("A-2");
        assertThat(this.fixtures.seatStatus(show.id(), "A-2")).isEqualTo("SOLD");
    }

    @Test
    void devolucaoComOSetorEsgotadoReabreOUltimoLote() {
        var primeiro = lot("1º lote", 10_000, 2);
        var segundo = lot("2º lote", 14_000, 2);
        CatalogShow show = this.fixtures.onSale(pista(primeiro, segundo));
        ReservationView doPrimeiro = sold(pistaRequest(show, 2, Cpfs.next()));
        sold(pistaRequest(show, 2, Cpfs.next()));
        assertThat(this.fixtures.lotStatus(segundo.id())).isEqualTo("SOLD_OUT");

        this.service.returnTickets(doPrimeiro.id());

        // Volta para o último lote, ao preço dele; o lote mais barato não reabre (ADR 25).
        assertThat(this.fixtures.lotStatus(segundo.id())).isEqualTo("ON_SALE");
        assertThat(this.fixtures.available(segundo.id())).isEqualTo(2);
        assertThat(this.fixtures.lotStatus(primeiro.id())).isEqualTo("SOLD_OUT");
        assertThat(this.fixtures.available(primeiro.id())).isZero();
        assertThat(reserve(pistaRequest(show, 2, Cpfs.next())).totalCents()).isEqualTo(28_000);
    }

    @Test
    void devolucaoVaiParaOLoteEmVendaENaoParaOLoteDaReserva() {
        var primeiro = lot("1º lote", 10_000, 2);
        var segundo = lot("2º lote", 14_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(primeiro, segundo));
        ReservationView doPrimeiro = sold(pistaRequest(show, 2, Cpfs.next()));

        this.service.returnTickets(doPrimeiro.id());

        assertThat(this.fixtures.available(segundo.id())).isEqualTo(12);
        assertThat(this.fixtures.available(primeiro.id())).isZero();
        assertThat(this.fixtures.lotStatus(primeiro.id())).isEqualTo("SOLD_OUT");
        // O fato diz de que lote os ingressos saíram.
        assertThat(returnedFact(doPrimeiro.id()).get("payload").get("lotId").asString())
                .isEqualTo(primeiro.id().toString());
    }

    @Test
    void comAsVendasEncerradasNaoRevendeMasDevolveCadeirasECota() {
        var setor = cadeiras(1, 4, 20_000);
        CatalogShow show = this.fixtures.onSale(setor);
        UUID lote = setor.lots().getFirst().id();
        ReservationView reservation = sold(seatsRequest(show, setor.id(), Cpfs.next(), "A-1"));
        closeSales(show);

        ReservationView returned = this.service.returnTickets(reservation.id()).reservation();

        assertThat(returned.status()).isEqualTo(ReservationStatus.RETURNED);
        assertThat(this.fixtures.lotStatus(lote)).isEqualTo("CLOSED");
        assertThat(this.fixtures.available(lote)).isEqualTo(3);
        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("AVAILABLE");
        assertThat(cpfQuota(show.id())).isZero();
        returnedFact(reservation.id());
        assertThatThrownBy(() -> reserve(seatsRequest(show, setor.id(), Cpfs.next(), "A-1")))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("sales-closed"));
    }

    @Test
    void devolverDeNovoNaoDevolveEstoqueEmDobroNemGeraOutroFato() {
        var lote = lot("Lote único", 10_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        ReservationView reservation = sold(pistaRequest(show, 3, Cpfs.next()));

        var results = Concurrently.run(5, i -> this.service.returnTickets(reservation.id()).reservation().status());
        this.service.returnTickets(reservation.id());

        assertThat(results).allSatisfy(result -> assertThat(result.value()).isEqualTo(ReservationStatus.RETURNED));
        assertThat(this.fixtures.available(lote.id())).isEqualTo(10);
        assertThat(factsAbout(reservation.id())).containsExactly("ReservationConfirmed", "ReservationReturned");
    }

    @Test
    void soReservaConfirmadaPodeSerDevolvida() {
        var lote = lot("Lote único", 10_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        ReservationView held = reserve(pistaRequest(show, 1, Cpfs.next()));
        ReservationView released = reserve(pistaRequest(show, 1, Cpfs.next()));
        this.service.release(released.id());
        ReservationView expired = reserve(pistaRequest(show, 1, Cpfs.next()));
        this.clock.advance(Duration.ofMinutes(11));
        assertThat(this.service.expire(expired.id())).isTrue();
        int available = this.fixtures.available(lote.id());

        for (ReservationView reservation : List.of(held, released, expired)) {
            ReservationStatus before = statusOf(reservation.id());
            assertThatThrownBy(() -> this.service.returnTickets(reservation.id())).satisfies(e -> {
                assertThat(slugOf(e)).isEqualTo("reservation-not-confirmed");
                assertThat(((ProblemException) e).toProblemDetail().getProperties()).containsEntry("status", before);
            });
            assertThat(statusOf(reservation.id())).isEqualTo(before);
        }
        assertThatThrownBy(() -> this.service.returnTickets(UUID.randomUUID()))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("not-found"));

        assertThat(this.fixtures.available(lote.id())).isEqualTo(available);
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(1);
        assertThat(factsAbout(held.id())).isEmpty();
        assertThat(factsAbout(released.id())).containsExactly("ReservationReleased");
        assertThat(factsAbout(expired.id())).containsExactly("ReservationReleased");
    }

    @Test
    void devolucaoDisputandoComReservasNovasNuncaVendeAlemDaCapacidade() {
        var lote = lot("Lote único", 10_000, 5);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        ReservationView devolvida = sold(pistaRequest(show, 4, Cpfs.next()));
        sold(pistaRequest(show, 1, Cpfs.next()));
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("SOLD_OUT");

        // Uma tarefa devolve 4 ingressos enquanto 30 compradores tentam 1 cada.
        var results = Concurrently.run(31, i -> i == 0
                ? this.service.returnTickets(devolvida.id()).reservation()
                : reserve(pistaRequest(show, 1, Cpfs.next())));

        assertThat(results.getFirst().succeeded()).isTrue();
        List<Result<ReservationView>> bought = results.subList(1, results.size()).stream()
                .filter(Result::succeeded).toList();
        assertThat(bought.size()).isLessThanOrEqualTo(4);
        assertThat(results.stream().filter(result -> !result.succeeded()).map(result -> slugOf(result.error())))
                .isSubsetOf("sold-out", "insufficient-stock");
        // O que está vendido ou segurado mais o que sobrou no contador é sempre a capacidade.
        assertThat(this.fixtures.reservedTickets(show.id()) + this.fixtures.available(lote.id())).isEqualTo(5);
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo(1 + bought.size());
    }
}

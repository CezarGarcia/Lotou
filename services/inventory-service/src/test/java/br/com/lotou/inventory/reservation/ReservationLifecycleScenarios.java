package br.com.lotou.inventory.reservation;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static br.com.lotou.inventory.support.Fixtures.pistaRequest;
import static br.com.lotou.inventory.support.Fixtures.seatsRequest;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.support.Concurrently;
import br.com.lotou.inventory.support.Concurrently.Result;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.MutableClock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;

/** O ciclo da reserva: segurar, confirmar, liberar e expirar. */
abstract class ReservationLifecycleScenarios {

    @Autowired
    private ReservationService service;

    @Autowired
    private ReservationExpiryJob expiryJob;

    @Autowired
    private Fixtures fixtures;

    @Autowired
    private MutableClock clock;

    @AfterEach
    void resetClock() {
        this.clock.reset();
    }

    /** O job de expiração varre o Postgres: no motor Redis, espera o stream chegar ao banco. */
    private int expireDue() {
        this.fixtures.settle();
        return this.expiryJob.expireDue();
    }

    private ReservationView reserve(CreateReservationRequest request) {
        return this.service.reserve("comprador-" + UUID.randomUUID(), UUID.randomUUID().toString(), request)
                .reservation();
    }

    private static String slugOf(Throwable error) {
        return ((ProblemException) error).slug();
    }

    @Test
    void reservaSeguraPorDezMinutosComOPrecoDoLote() {
        var lote = lot("1º lote", 18_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));

        ReservationView reservation = reserve(pistaRequest(show, 3, Cpfs.next()));

        assertThat(reservation.status()).isEqualTo(ReservationStatus.HELD);
        assertThat(reservation.totalCents()).isEqualTo(54_000);
        assertThat(Duration.between(reservation.createdAt(), reservation.expiresAt()))
                .isEqualTo(Duration.ofMinutes(10));
        assertThat(reservation.items()).hasSize(3)
                .allSatisfy(item -> {
                    assertThat(item.lotId()).isEqualTo(lote.id());
                    assertThat(item.unitPriceCents()).isEqualTo(18_000);
                    assertThat(item.seat()).isNull();
                });
        assertThat(this.fixtures.available(lote.id())).isEqualTo(7);
    }

    @Test
    void precoFicaCongeladoMesmoQueOLoteVireDepois() {
        var primeiro = lot("1º lote", 10_000, 2);
        var segundo = lot("2º lote", 15_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(primeiro, segundo));

        ReservationView doPrimeiro = reserve(pistaRequest(show, 2, Cpfs.next()));
        ReservationView doSegundo = reserve(pistaRequest(show, 1, Cpfs.next()));
        this.service.confirm(doPrimeiro.id());

        assertThat(this.service.get(doPrimeiro.id()).reservation().totalCents()).isEqualTo(20_000);
        assertThat(doSegundo.totalCents()).isEqualTo(15_000);
    }

    @Test
    void confirmarVendeAsCadeirasEEhIdempotente() {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);
        ReservationView reservation = reserve(seatsRequest(show, setor.id(), Cpfs.next(), "A-1", "A-2"));

        this.service.confirm(reservation.id());
        ReservationView again = this.service.confirm(reservation.id()).reservation();

        assertThat(again.status()).isEqualTo(ReservationStatus.CONFIRMED);
        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("SOLD");
        assertThat(this.fixtures.seatStatus(show.id(), "A-2")).isEqualTo("SOLD");
        assertThat(this.fixtures.available(setor.lots().getFirst().id())).isEqualTo(8);
    }

    @Test
    void liberarDevolveEstoqueCadeirasECotaDoCpf() {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);
        String cpf = Cpfs.next();
        ReservationView reservation = reserve(seatsRequest(show, setor.id(), cpf, "A-1", "A-2", "A-3", "A-4"));
        assertThatThrownBy(() -> reserve(seatsRequest(show, setor.id(), cpf, "A-5")))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("purchase-limit-exceeded"));

        this.service.release(reservation.id());
        this.service.release(reservation.id()); // idempotente

        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("AVAILABLE");
        assertThat(this.fixtures.available(setor.lots().getFirst().id())).isEqualTo(10);
        // Reserva liberada devolve a cota: o mesmo CPF compra de novo.
        assertThat(reserve(seatsRequest(show, setor.id(), cpf, "A-1", "A-2", "A-3", "A-4")).quantity())
                .isEqualTo(4);
    }

    @Test
    void reservaExpiraDepoisDoPrazoEOsIngressosVoltamAVenda() {
        var lote = lot("Lote único", 12_000, 4);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        String cpf = Cpfs.next();
        ReservationView reservation = reserve(pistaRequest(show, 4, cpf));
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("SOLD_OUT");

        this.clock.advance(Duration.ofMinutes(9));
        assertThat(expireDue()).isZero();

        this.clock.advance(Duration.ofMinutes(2));
        assertThat(expireDue()).isGreaterThanOrEqualTo(1);

        assertThat(this.service.get(reservation.id()).reservation().status())
                .isEqualTo(ReservationStatus.EXPIRED);
        // O setor estava esgotado: a devolução reabre o último lote.
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("ON_SALE");
        assertThat(this.fixtures.available(lote.id())).isEqualTo(4);
        assertThat(reserve(pistaRequest(show, 4, cpf)).status()).isEqualTo(ReservationStatus.HELD);
    }

    @Test
    void reservaConfirmadaNaoExpiraEReservaExpiradaNaoConfirma() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 10)));
        ReservationView paid = reserve(pistaRequest(show, 1, Cpfs.next()));
        ReservationView abandoned = reserve(pistaRequest(show, 1, Cpfs.next()));
        this.service.confirm(paid.id());

        this.clock.advance(Duration.ofMinutes(11));
        expireDue();

        assertThat(this.service.get(paid.id()).reservation().status()).isEqualTo(ReservationStatus.CONFIRMED);
        assertThatThrownBy(() -> this.service.confirm(abandoned.id())).satisfies(e -> {
            assertThat(slugOf(e)).isEqualTo("reservation-not-held");
            assertThat(((ProblemException) e).toProblemDetail().getProperties())
                    .containsEntry("status", ReservationStatus.EXPIRED);
        });
        assertThatThrownBy(() -> this.service.release(paid.id()))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("reservation-not-held"));
    }

    @Test
    void confirmarEExpirarAoMesmoTempoTemUmSoVencedor() {
        var lote = lot("Lote único", 12_000, 30);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        var reservations = java.util.stream.IntStream.range(0, 30)
                .mapToObj(i -> reserve(pistaRequest(show, 1, Cpfs.next())))
                .toList();
        this.clock.advance(Duration.ofMinutes(11));

        // Metade das tarefas confirma, metade expira, todas na mesma reserva de cada par.
        var results = Concurrently.run(60, i -> {
            UUID id = reservations.get(i / 2).id();
            if (i % 2 == 0) {
                return this.service.confirm(id).reservation().status().name();
            }
            return this.service.expire(id) ? "EXPIRED" : "kept";
        });

        long confirmed = results.stream().filter(Result::succeeded).filter(r -> r.value().equals("CONFIRMED")).count();
        long expired = results.stream().filter(Result::succeeded).filter(r -> r.value().equals("EXPIRED")).count();
        assertThat(confirmed + expired).isEqualTo(30);
        // O estoque bate: só as reservas expiradas voltaram à venda.
        assertThat(this.fixtures.available(lote.id())).isEqualTo((int) expired);
        assertThat(this.fixtures.reservedTickets(show.id())).isEqualTo((int) confirmed);
    }

    @Test
    void recusaReservaQueNaoCombinaComOTipoDoSetor() {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow seated = this.fixtures.onSale(setor);
        CatalogShow standing = this.fixtures.onSale(pista(lot("Lote único", 12_000, 10)));

        assertThatThrownBy(() -> reserve(pistaRequest(seated, 2, Cpfs.next())))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("validation-error"));
        assertThatThrownBy(() -> reserve(seatsRequest(standing, standing.sectors().getFirst().id(), Cpfs.next(), "A-1")))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("validation-error"));
        assertThatThrownBy(() -> reserve(seatsRequest(seated, setor.id(), Cpfs.next(), "Z-99")))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("seat-not-found"));
        assertThatThrownBy(() -> reserve(pistaRequest(standing, 1, "111.111.111-11")))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("validation-error"));
    }

    @Test
    void naoVendeAntesDaAberturaDasVendas() {
        CatalogShow show = this.fixtures.publish(this.fixtures.show(this.clock.instant().plus(Duration.ofDays(3)),
                pista(lot("Lote único", 12_000, 10))));

        assertThatThrownBy(() -> reserve(pistaRequest(show, 1, Cpfs.next())))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("sales-not-open"));
    }
}

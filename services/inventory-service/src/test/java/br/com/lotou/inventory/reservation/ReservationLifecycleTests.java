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
import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.MutableClock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;

/** O ciclo da reserva: segurar, confirmar, liberar e expirar. */
@IntegrationTest
class ReservationLifecycleTests {

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

    private Reservation reserve(CreateReservationRequest request) {
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

        Reservation reservation = reserve(pistaRequest(show, 3, Cpfs.next()));

        assertThat(reservation.getStatus()).isEqualTo(ReservationStatus.HELD);
        assertThat(reservation.getTotalCents()).isEqualTo(54_000);
        assertThat(Duration.between(reservation.getCreatedAt(), reservation.getExpiresAt()))
                .isEqualTo(Duration.ofMinutes(10));
        assertThat(reservation.getItems()).hasSize(3)
                .allSatisfy(item -> {
                    assertThat(item.getLotId()).isEqualTo(lote.id());
                    assertThat(item.getUnitPriceCents()).isEqualTo(18_000);
                    assertThat(item.getSeatLabel()).isNull();
                });
        assertThat(this.fixtures.available(lote.id())).isEqualTo(7);
    }

    @Test
    void precoFicaCongeladoMesmoQueOLoteVireDepois() {
        var primeiro = lot("1º lote", 10_000, 2);
        var segundo = lot("2º lote", 15_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(primeiro, segundo));

        Reservation doPrimeiro = reserve(pistaRequest(show, 2, Cpfs.next()));
        Reservation doSegundo = reserve(pistaRequest(show, 1, Cpfs.next()));
        this.service.confirm(doPrimeiro.getId());

        assertThat(this.service.get(doPrimeiro.getId()).reservation().getTotalCents()).isEqualTo(20_000);
        assertThat(doSegundo.getTotalCents()).isEqualTo(15_000);
    }

    @Test
    void confirmarVendeAsCadeirasEEhIdempotente() {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);
        Reservation reservation = reserve(seatsRequest(show, setor.id(), Cpfs.next(), "A-1", "A-2"));

        this.service.confirm(reservation.getId());
        Reservation again = this.service.confirm(reservation.getId()).reservation();

        assertThat(again.getStatus()).isEqualTo(ReservationStatus.CONFIRMED);
        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("SOLD");
        assertThat(this.fixtures.seatStatus(show.id(), "A-2")).isEqualTo("SOLD");
        assertThat(this.fixtures.available(setor.lots().getFirst().id())).isEqualTo(8);
    }

    @Test
    void liberarDevolveEstoqueCadeirasECotaDoCpf() {
        var setor = cadeiras(1, 10, 30_000);
        CatalogShow show = this.fixtures.onSale(setor);
        String cpf = Cpfs.next();
        Reservation reservation = reserve(seatsRequest(show, setor.id(), cpf, "A-1", "A-2", "A-3", "A-4"));
        assertThatThrownBy(() -> reserve(seatsRequest(show, setor.id(), cpf, "A-5")))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("purchase-limit-exceeded"));

        this.service.release(reservation.getId());
        this.service.release(reservation.getId()); // idempotente

        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("AVAILABLE");
        assertThat(this.fixtures.available(setor.lots().getFirst().id())).isEqualTo(10);
        // Reserva liberada devolve a cota: o mesmo CPF compra de novo.
        assertThat(reserve(seatsRequest(show, setor.id(), cpf, "A-1", "A-2", "A-3", "A-4")).getQuantity())
                .isEqualTo(4);
    }

    @Test
    void reservaExpiraDepoisDoPrazoEOsIngressosVoltamAVenda() {
        var lote = lot("Lote único", 12_000, 4);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        String cpf = Cpfs.next();
        Reservation reservation = reserve(pistaRequest(show, 4, cpf));
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("SOLD_OUT");

        this.clock.advance(Duration.ofMinutes(9));
        assertThat(this.expiryJob.expireDue()).isZero();

        this.clock.advance(Duration.ofMinutes(2));
        assertThat(this.expiryJob.expireDue()).isGreaterThanOrEqualTo(1);

        assertThat(this.service.get(reservation.getId()).reservation().getStatus())
                .isEqualTo(ReservationStatus.EXPIRED);
        // O setor estava esgotado: a devolução reabre o último lote.
        assertThat(this.fixtures.lotStatus(lote.id())).isEqualTo("ON_SALE");
        assertThat(this.fixtures.available(lote.id())).isEqualTo(4);
        assertThat(reserve(pistaRequest(show, 4, cpf)).getStatus()).isEqualTo(ReservationStatus.HELD);
    }

    @Test
    void reservaConfirmadaNaoExpiraEReservaExpiradaNaoConfirma() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 12_000, 10)));
        Reservation paid = reserve(pistaRequest(show, 1, Cpfs.next()));
        Reservation abandoned = reserve(pistaRequest(show, 1, Cpfs.next()));
        this.service.confirm(paid.getId());

        this.clock.advance(Duration.ofMinutes(11));
        this.expiryJob.expireDue();

        assertThat(this.service.get(paid.getId()).reservation().getStatus()).isEqualTo(ReservationStatus.CONFIRMED);
        assertThatThrownBy(() -> this.service.confirm(abandoned.getId())).satisfies(e -> {
            assertThat(slugOf(e)).isEqualTo("reservation-not-held");
            assertThat(((ProblemException) e).toProblemDetail().getProperties())
                    .containsEntry("status", ReservationStatus.EXPIRED);
        });
        assertThatThrownBy(() -> this.service.release(paid.getId()))
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
            UUID id = reservations.get(i / 2).getId();
            if (i % 2 == 0) {
                return this.service.confirm(id).reservation().getStatus().name();
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

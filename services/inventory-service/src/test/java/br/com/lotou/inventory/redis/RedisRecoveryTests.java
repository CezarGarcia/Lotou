package br.com.lotou.inventory.redis;

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
import br.com.lotou.inventory.lot.SalesEngine;
import br.com.lotou.inventory.reservation.CreateReservationRequest;
import br.com.lotou.inventory.reservation.ReservationService;
import br.com.lotou.inventory.reservation.ReservationStatus;
import br.com.lotou.inventory.reservation.ReservationView;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.IntegrationTest;
import br.com.lotou.inventory.support.MutableClock;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * O que acontece se o {@code redis-core} perder os dados no meio das vendas (o experimento de caos
 * "redis-core reiniciado" de docs/projeto.md): o job percebe que a marca do show sumiu e reconstrói
 * o estado de venda a partir do Postgres, que recebeu tudo pelo stream.
 */
@IntegrationTest
class RedisRecoveryTests {

    @Autowired
    private ReservationService reservations;

    @Autowired
    private SalesEngine sales;

    @Autowired
    private ReservationProjection projection;

    @Autowired
    private Fixtures fixtures;

    @Autowired
    private StringRedisTemplate redis;

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private MutableClock clock;

    @AfterEach
    void resetClock() {
        this.clock.reset();
    }

    private ReservationView reserve(String buyer, String key, CreateReservationRequest request) {
        return this.reservations.reserve(buyer, key, request).reservation();
    }

    /** Apaga tudo do Redis, como um restart sem AOF, e deixa o job perceber. */
    private void loseRedisAndRecover() {
        this.redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) connection -> {
            connection.serverCommands().flushAll();
            return null;
        });
        this.sales.maintain(this.clock.instant());
    }

    @Test
    void reconstroiEstoqueCadeirasCotasEReservasAtivasAPartirDoPostgres() {
        var primeiro = lot("1º lote", 10_000, 3);
        var segundo = lot("2º lote", 14_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(primeiro, segundo), cadeiras(1, 5, 30_000));
        UUID seated = show.sectors().get(1).id();
        String cpf = Cpfs.next();
        String key = UUID.randomUUID().toString();
        CreateReservationRequest first = pistaRequest(show, 3, cpf);

        ReservationView held = reserve("ana", key, first);           // esgota o 1º lote; o 2º abre
        ReservationView paid = reserve("bia", UUID.randomUUID().toString(), pistaRequest(show, 2, Cpfs.next()));
        this.reservations.confirm(paid.id());
        ReservationView seats = reserve("caio", UUID.randomUUID().toString(),
                seatsRequest(show, seated, Cpfs.next(), "A-2", "A-4"));
        this.fixtures.settle();

        loseRedisAndRecover();

        // Estoque: o 2º lote segue em venda com o que restava.
        var pistaNow = this.sales.availability(show.id()).getFirst();
        assertThat(pistaNow.lot().name()).isEqualTo("2º lote");
        assertThat(pistaNow.available()).isEqualTo(8);
        // Cadeiras: as seguradas continuam ocupadas.
        assertThat(this.sales.seats(show.id(), seated))
                .filteredOn(seat -> !seat.available())
                .extracting(SalesEngine.SeatAvailability::label)
                .containsExactly("A-2", "A-4");
        assertThatThrownBy(() -> reserve("duda", UUID.randomUUID().toString(),
                seatsRequest(show, seated, Cpfs.next(), "A-4")))
                .satisfies(e -> assertThat(((ProblemException) e).slug()).isEqualTo("seat-unavailable"));
        // Cota do CPF: os 3 ingressos de ana continuam contando.
        assertThatThrownBy(() -> reserve("outra-conta", UUID.randomUUID().toString(), pistaRequest(show, 2, cpf)))
                .satisfies(e -> assertThat(((ProblemException) e).slug()).isEqualTo("purchase-limit-exceeded"));
        // Idempotência: repetir a mesma reserva devolve a que já existe.
        assertThat(this.reservations.reserve("ana", key, first).replayed()).isTrue();
        // A reserva ativa continua ativa: confirma normalmente.
        assertThat(this.reservations.confirm(held.id()).reservation().status()).isEqualTo(ReservationStatus.CONFIRMED);
        // E a reserva de cadeiras ainda expira e devolve as cadeiras.
        this.clock.advance(Duration.ofMinutes(11));
        assertThat(this.reservations.expire(seats.id())).isTrue();
        assertThat(this.sales.seats(show.id(), seated)).allMatch(SalesEngine.SeatAvailability::available);
    }

    @Test
    void oConsumidorDoStreamVoltaSozinhoDepoisQueOGrupoSome() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 10_000, 50)));
        reserve("ana", UUID.randomUUID().toString(), pistaRequest(show, 1, Cpfs.next()));
        this.fixtures.settle();

        loseRedisAndRecover();
        ReservationView after = reserve("bia", UUID.randomUUID().toString(), pistaRequest(show, 1, Cpfs.next()));
        this.fixtures.settle();

        assertThat(this.jdbc.sql("SELECT status FROM reservations WHERE id = :id").param("id", after.id())
                .query(String.class).single()).isEqualTo("HELD");
        assertThat(this.projection.caughtUp()).isTrue();
    }
}

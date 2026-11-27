package br.com.lotou.inventory.reservation;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static br.com.lotou.inventory.support.Fixtures.pistaRequest;
import static br.com.lotou.inventory.support.Fixtures.seatsRequest;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.catalog.CatalogCache;
import br.com.lotou.inventory.redis.RedisKeys;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.IntegrationTest;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * Motor Redis (fase 2): {@code return.lua}, com o Postgres alimentado pelo stream. Além dos
 * cenários comuns, os casos em que a reserva ou o show já não estão no Redis.
 */
@IntegrationTest
class ReservationReturnRedisTests extends ReservationReturnScenarios {

    @Autowired
    private StringRedisTemplate redis;

    @Autowired
    private CatalogCache catalog;

    private boolean bit(UUID showId, UUID sectorId, String label) {
        int position = this.catalog.seats(showId, sectorId).get(label).position();
        return Boolean.TRUE.equals(this.redis.opsForValue().getBit(RedisKeys.seatMap(showId, sectorId), position));
    }

    private void flushRedis() {
        this.redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) connection -> {
            connection.serverCommands().flushAll();
            return null;
        });
    }

    @Test
    void devolucaoLimpaOBitmapEAChaveDaCadeira() {
        var setor = cadeiras(1, 4, 20_000);
        CatalogShow show = this.fixtures.onSale(setor);
        ReservationView reservation = sold(seatsRequest(show, setor.id(), Cpfs.next(), "A-3"));
        UUID seatId = this.catalog.seats(show.id(), setor.id()).get("A-3").id();
        assertThat(bit(show.id(), setor.id(), "A-3")).isTrue();

        this.service.returnTickets(reservation.id());

        assertThat(bit(show.id(), setor.id(), "A-3")).isFalse();
        assertThat(this.redis.hasKey(RedisKeys.seat(show.id(), seatId))).isFalse();
        assertThat(this.redis.opsForHash().get(RedisKeys.reservation(reservation.id()), "status"))
                .isEqualTo("RETURNED");
    }

    /** O cancelamento chega depois que a reserva concluída saiu do Redis (um dia depois). */
    @Test
    void reservaQueJaSaiuDoRedisEDevolvidaComOQueEstaNoPostgres() {
        var setor = cadeiras(1, 4, 20_000);
        CatalogShow show = this.fixtures.onSale(setor);
        String cpf = Cpfs.next();
        ReservationView reservation = sold(seatsRequest(show, setor.id(), cpf, "A-1", "A-2", "A-3", "A-4"));
        this.fixtures.settle();
        this.redis.delete(RedisKeys.reservation(reservation.id()));

        ReservationView returned = this.service.returnTickets(reservation.id()).reservation();
        this.service.returnTickets(reservation.id());

        assertThat(returned.status()).isEqualTo(ReservationStatus.RETURNED);
        assertThat(returned.items()).extracting(ReservationView.Item::seat).containsExactly("A-1", "A-2", "A-3", "A-4");
        assertThat(this.fixtures.available(setor.lots().getFirst().id())).isEqualTo(4);
        assertThat(this.fixtures.seatStatus(show.id(), "A-4")).isEqualTo("AVAILABLE");
        assertThat(bit(show.id(), setor.id(), "A-4")).isFalse();
        assertThat(factsAbout(reservation.id())).containsExactly("ReservationConfirmed", "ReservationReturned");
        assertThat(reserve(seatsRequest(show, setor.id(), cpf, "A-1", "A-2", "A-3", "A-4")).quantity()).isEqualTo(4);
    }

    /** O Redis perdeu os dados depois do encerramento: o show não volta para ele, vale o Postgres. */
    @Test
    void comAsVendasEncerradasESemOShowNoRedisDevolveNoPostgres() {
        var setor = cadeiras(1, 4, 20_000);
        CatalogShow show = this.fixtures.onSale(setor);
        ReservationView reservation = sold(seatsRequest(show, setor.id(), Cpfs.next(), "A-1", "A-2"));
        closeSales(show);
        this.fixtures.settle();
        flushRedis();

        ReservationView returned = this.service.returnTickets(reservation.id()).reservation();
        this.service.returnTickets(reservation.id());

        assertThat(returned.status()).isEqualTo(ReservationStatus.RETURNED);
        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("AVAILABLE");
        assertThat(this.fixtures.lotStatus(setor.lots().getFirst().id())).isEqualTo("CLOSED");
        assertThat(cpfQuota(show.id())).isZero();
        assertThat(returnedFact(reservation.id()).get("payload").get("quantity").asInt()).isEqualTo(2);
    }

    /** Com as vendas abertas, o show volta para o Redis em instantes: o comando é repetido depois. */
    @Test
    void comAsVendasAbertasESemOShowNoRedisPedeParaTentarDeNovo() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 10_000, 10)));
        ReservationView reservation = sold(pistaRequest(show, 2, Cpfs.next()));
        this.fixtures.settle();
        flushRedis();

        assertThatThrownBy(() -> this.service.returnTickets(reservation.id()))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("inventory-loading"));
        assertThat(statusOf(reservation.id())).isEqualTo(ReservationStatus.CONFIRMED);

        this.sales.maintain(this.clock.instant());
        this.service.returnTickets(reservation.id());
        assertThat(this.fixtures.available(show.sectors().getFirst().lots().getFirst().id())).isEqualTo(10);
    }
}

package br.com.lotou.inventory.messaging;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow;
import br.com.lotou.inventory.catalog.CatalogShow.CatalogLot;
import br.com.lotou.inventory.catalog.CatalogShow.CatalogSector;
import br.com.lotou.inventory.reservation.ReservationExpiryJob;
import br.com.lotou.inventory.reservation.ReservationService;
import br.com.lotou.inventory.reservation.ReservationView;
import br.com.lotou.inventory.support.Contracts;
import br.com.lotou.inventory.support.Cpfs;
import br.com.lotou.inventory.support.Fixtures;
import br.com.lotou.inventory.support.MutableClock;
import br.com.lotou.inventory.support.TestKafka;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.simple.JdbcClient;

import static br.com.lotou.inventory.support.Fixtures.cadeiras;
import static br.com.lotou.inventory.support.Fixtures.lot;
import static br.com.lotou.inventory.support.Fixtures.pista;
import static br.com.lotou.inventory.support.Fixtures.pistaRequest;
import static br.com.lotou.inventory.support.Fixtures.seatsRequest;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * O inventory no Kafka: os comandos da saga mudam a reserva, e toda mudança de status de reserva e
 * de lote vira um fato em inventory.events, gravado no outbox na mesma transação e publicado pelo
 * relay. Roda contra os dois motores de reserva.
 */
abstract class InventoryEventsScenarios {

    @Autowired
    private ReservationService service;

    @Autowired
    private ReservationExpiryJob expiryJob;

    @Autowired
    private OutboxRelay relay;

    @Autowired
    private Fixtures fixtures;

    @Autowired
    private MutableClock clock;

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private JsonMapper json;

    @AfterEach
    void resetClock() {
        this.clock.reset();
    }

    @Test
    void confirmarPeloComandoPublicaReservationConfirmed() {
        var setor = cadeiras(1, 4, 20_000);
        CatalogShow show = this.fixtures.onSale(setor);
        ReservationView reservation = reserve(seatsRequest(show, setor.id(), Cpfs.next(), "A-1", "A-2"));

        command("ConfirmReservation", reservation.id(), null);

        JsonNode fact = awaitFact(reservation.id(), "ReservationConfirmed");
        assertThat(fact.get("payload").get("seats").valueStream().map(JsonNode::asString).toList())
                .containsExactly("A-1", "A-2");
        assertThat(fact.get("payload").get("quantity").asInt()).isEqualTo(2);
        assertThat(this.fixtures.seatStatus(show.id(), "A-1")).isEqualTo("SOLD");
    }

    @Test
    void liberarPeloComandoPublicaReservationReleasedEDevolveOEstoque() {
        var lote = lot("Lote único", 10_000, 10);
        CatalogShow show = this.fixtures.onSale(pista(lote));
        ReservationView reservation = reserve(pistaRequest(show, 3, Cpfs.next()));

        command("ReleaseReservation", reservation.id(), "PAYMENT_DECLINED");

        JsonNode fact = awaitFact(reservation.id(), "ReservationReleased");
        assertThat(fact.get("payload").get("reason").asString()).isEqualTo("RELEASED");
        assertThat(fact.get("payload").get("lotId").asString()).isEqualTo(lote.id().toString());
        assertThat(this.fixtures.available(lote.id())).isEqualTo(10);
    }

    @Test
    void reservaExpiradaPublicaReservationReleasedComMotivoExpired() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 10_000, 10)));
        ReservationView reservation = reserve(pistaRequest(show, 1, Cpfs.next()));

        this.clock.advance(Duration.ofMinutes(11));
        this.fixtures.settle();
        this.expiryJob.expireDue();

        JsonNode fact = awaitFact(reservation.id(), "ReservationReleased");
        assertThat(fact.get("payload").get("reason").asString()).isEqualTo("EXPIRED");
    }

    @Test
    void comandoParaReservaQueJaNaoEstaSeguradaNaoGeraFatoNovo() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 10_000, 10)));
        ReservationView reservation = reserve(pistaRequest(show, 1, Cpfs.next()));
        command("ConfirmReservation", reservation.id(), null);
        awaitFact(reservation.id(), "ReservationConfirmed");

        // Repetido, e um pedido de liberação que chega tarde: nada muda.
        command("ConfirmReservation", reservation.id(), null);
        command("ReleaseReservation", reservation.id(), "PAYMENT_DECLINED");
        command("ConfirmReservation", UUID.randomUUID(), null);
        UUID marker = this.fixtures.onSale(pista(lot("Marcador", 1_000, 1))).id();
        Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> factsOfShow(marker) > 0);
        this.fixtures.settle();

        assertThat(factsAbout(reservation.id())).containsExactly("ReservationConfirmed");
    }

    @Test
    void loteQueEsgotaPublicaLotSoldOutEOProximoLotOpened() {
        CatalogLot primeiro = lot("1º lote", 10_000, 2);
        CatalogLot segundo = lot("2º lote", 14_000, 5);
        CatalogSector setor = pista(primeiro, segundo);
        CatalogShow show = this.fixtures.onSale(setor);

        reserve(pistaRequest(show, 2, Cpfs.next()));

        Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> {
            this.fixtures.settle();
            return lotFacts(show.id()).containsAll(List.of("LotOpened:" + primeiro.id(),
                    "LotSoldOut:" + primeiro.id(), "LotOpened:" + segundo.id()));
        });
        JsonNode opened = outboxEnvelopes(show.id()).stream()
                .filter(e -> e.get("type").asString().equals("LotOpened")
                        && e.get("payload").get("lotId").asString().equals(segundo.id().toString()))
                .findFirst().orElseThrow();
        assertThat(opened.get("payload").get("priceCents").asLong()).isEqualTo(14_000);
        assertThat(opened.get("payload").get("available").asInt()).isEqualTo(5);
    }

    @Test
    void todoFatoDoOutboxPassaNoContratoEERepublicado() {
        CatalogShow show = this.fixtures.onSale(pista(lot("Lote único", 10_000, 10)));
        ReservationView reservation = reserve(pistaRequest(show, 1, Cpfs.next()));
        command("ConfirmReservation", reservation.id(), null);
        awaitFact(reservation.id(), "ReservationConfirmed");

        this.relay.publishPending();
        assertThat(this.jdbc.sql("SELECT count(*) FROM outbox WHERE published_at IS NULL").query(Long.class)
                .single()).isZero();
        this.jdbc.sql("SELECT type, envelope::text FROM outbox")
                .query((rs, row) -> new String[] { rs.getString(1), rs.getString(2) })
                .list()
                .forEach(fact -> Contracts.assertValid("inventory.events", fact[0], fact[1]));
    }

    // ------------------------------------------------------------------ apoio

    private ReservationView reserve(br.com.lotou.inventory.reservation.CreateReservationRequest request) {
        return this.service.reserve("comprador-" + UUID.randomUUID(), UUID.randomUUID().toString(), request)
                .reservation();
    }

    /** Publica um comando da saga, como o order-service publicaria. */
    private void command(String type, UUID reservationId, String reason) {
        UUID orderId = UUID.randomUUID();
        String payload = reason == null
                ? "{\"orderId\": \"%s\", \"reservationId\": \"%s\"}".formatted(orderId, reservationId)
                : "{\"orderId\": \"%s\", \"reservationId\": \"%s\", \"reason\": \"%s\"}".formatted(orderId,
                        reservationId, reason);
        String message = """
                {"eventId": "%s", "type": "%s", "version": 1, "occurredAt": "2026-11-26T18:00:00Z", "payload": %s}
                """.formatted(UUID.randomUUID(), type, payload);
        Contracts.assertValid("inventory.commands", type, message);
        TestKafka.send("inventory.commands", orderId.toString(), message);
    }

    /** Espera o fato chegar ao outbox (no motor Redis, depois de o stream chegar ao Postgres). */
    private JsonNode awaitFact(UUID reservationId, String type) {
        JsonNode fact = Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> {
            this.fixtures.settle();
            return this.jdbc.sql("""
                    SELECT envelope::text FROM outbox
                    WHERE type = :type AND envelope -> 'payload' ->> 'reservationId' = :id
                    """).param("type", type).param("id", reservationId.toString()).query(String.class)
                    .optional().map(this.json::readTree).orElse(null);
        }, found -> found != null);
        Contracts.assertValid("inventory.events", type, fact.toString());
        return fact;
    }

    private List<String> factsAbout(UUID reservationId) {
        return this.jdbc.sql("""
                SELECT type FROM outbox WHERE envelope -> 'payload' ->> 'reservationId' = :id ORDER BY id
                """).param("id", reservationId.toString()).query(String.class).list();
    }

    private long factsOfShow(UUID showId) {
        return this.jdbc.sql("SELECT count(*) FROM outbox WHERE message_key = :show")
                .param("show", showId.toString()).query(Long.class).single();
    }

    private List<String> lotFacts(UUID showId) {
        return this.jdbc.sql("""
                SELECT type || ':' || (envelope -> 'payload' ->> 'lotId') FROM outbox
                WHERE message_key = :show AND type IN ('LotOpened', 'LotSoldOut') ORDER BY id
                """).param("show", showId.toString()).query(String.class).list();
    }

    private List<JsonNode> outboxEnvelopes(UUID showId) {
        return this.jdbc.sql("SELECT envelope::text FROM outbox WHERE message_key = :show ORDER BY id")
                .param("show", showId.toString()).query(String.class).list().stream()
                .map(this.json::readTree).toList();
    }
}

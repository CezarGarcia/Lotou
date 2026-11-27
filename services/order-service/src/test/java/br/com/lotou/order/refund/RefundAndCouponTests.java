package br.com.lotou.order.refund;

import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.messaging.OutboxRelay;
import br.com.lotou.order.support.CatalogFeed;
import br.com.lotou.order.support.Concurrently;
import br.com.lotou.order.support.Contracts;
import br.com.lotou.order.support.EndToEndEnvironment;
import br.com.lotou.order.support.InventoryStub;
import br.com.lotou.order.support.MutableClock;
import br.com.lotou.order.support.Neighbours;
import br.com.lotou.order.support.SagaCounterparts;
import br.com.lotou.order.support.TestBeans;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Fase 6 no order-service, pelo Kafka de verdade e com dublês dos vizinhos: taxa de serviço,
 * cupons (com o limite de usos sob disputa), cancelamento pelo comprador, a saga de reembolso com
 * as falhas do estorno, o reembolso em massa de um show cancelado e o ingresso usado na portaria.
 * Cada mensagem trocada é conferida contra contracts/.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(TestBeans.class)
class RefundAndCouponTests {

    private static final Neighbours neighbours = EndToEndEnvironment.NEIGHBOURS;
    private static final InventoryStub inventory = InventoryStub.start();
    private static final SagaCounterparts counterparts = SagaCounterparts.start();
    private static final long PRICE = 12_000;
    private static final String PRODUCER = "produtor-fase-6";

    @Autowired
    private MockMvc mvc;

    @Autowired
    private OutboxRelay relay;

    @Autowired
    private RefundJob refundJob;

    @Autowired
    private MutableClock clock;

    @Autowired
    private JdbcClient jdbc;

    @Autowired
    private JsonMapper json;

    @DynamicPropertySource
    static void environment(DynamicPropertyRegistry registry) {
        EndToEndEnvironment.configure(registry);
        registry.add("INVENTORY_SERVICE_URL", inventory::url);
        registry.add("lotou.order.saga.step-timeout", () -> "10s");
        // Vazão baixa, para ver a fila andar aos poucos.
        registry.add("lotou.order.refunds.rate", () -> "2");
    }

    @AfterAll
    static void stop() {
        inventory.close();
        counterparts.close();
    }

    @BeforeEach
    void reset() {
        inventory.reset();
        this.clock.reset();
    }

    // ------------------------------------------------------------ taxa e cupom

    @Test
    void cupomPercentualDescontaSoOsIngressosEATaxaVemDoComprador() throws Exception {
        Show show = show("BUYER", Duration.ofDays(30));
        String coupon = createCoupon(show, "LANCAMENTO10", "\"kind\": \"PERCENT\", \"percent\": 10", 5)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("ACTIVE"))
                .andExpect(jsonPath("$.remaining").value(5))
                .andReturn().getResponse().getContentAsString();
        UUID reservation = hold("cupom-feliz", show, 2);

        // Ingressos 24.000, desconto de 10% só sobre eles (2.400), taxa de 10% sobre o preço cheio (2.400).
        quote("cupom-feliz", reservation, "lancamento10")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.subtotalCents").value(24_000))
                .andExpect(jsonPath("$.discountCents").value(2_400))
                .andExpect(jsonPath("$.serviceFeeCents").value(2_400))
                .andExpect(jsonPath("$.serviceFeePaidBy").value("BUYER"))
                .andExpect(jsonPath("$.totalCents").value(24_000))
                .andExpect(jsonPath("$.coupon.code").value("LANCAMENTO10"))
                .andExpect(jsonPath("$.coupon.percent").value(10));

        UUID orderId = place("cupom-feliz", reservation, "LANCAMENTO10", 201);
        assertThat(counterparts.await("AuthorizePayment", orderId).payload().get("amountCents").asLong())
                .isEqualTo(24_000);
        JsonNode created = counterparts.await("OrderCreated", orderId).payload();
        assertThat(created.get("discountCents").asLong()).isEqualTo(2_400);
        assertThat(created.get("couponCode").asString()).isEqualTo("LANCAMENTO10");
        assertThat(created.get("couponId").asString()).isEqualTo(this.json.readTree(coupon).get("id").asString());

        this.mvc.perform(get("/v1/coupons").param("showId", show.id().toString()).header("Authorization",
                producer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].uses").value(1))
                .andExpect(jsonPath("$.items[0].remaining").value(4))
                .andExpect(jsonPath("$.items[0].discountGivenCents").value(2_400));
    }

    @Test
    void produtorQueAbsorveATaxaNaoACobraDoComprador() throws Exception {
        Show show = show("PRODUCER", Duration.ofDays(30));
        UUID reservation = hold("sem-taxa", show, 1);
        quote("sem-taxa", reservation, null)
                .andExpect(jsonPath("$.subtotalCents").value(PRICE))
                .andExpect(jsonPath("$.serviceFeeCents").value(PRICE / 10))
                .andExpect(jsonPath("$.serviceFeePaidBy").value("PRODUCER"))
                .andExpect(jsonPath("$.totalCents").value(PRICE))
                .andExpect(jsonPath("$.coupon").doesNotExist());
        UUID orderId = place("sem-taxa", reservation, null, 201);
        assertThat(counterparts.await("AuthorizePayment", orderId).payload().get("amountCents").asLong())
                .isEqualTo(PRICE);
    }

    @Test
    void cupomQueNaoServeERecusadoComOMotivo() throws Exception {
        Show show = show("BUYER", Duration.ofDays(30));
        createCoupon(show, "PAUSADO", "\"kind\": \"AMOUNT\", \"amountCents\": 5000", 10).andExpect(status().isCreated());
        createCoupon(show, "PAUSADO", "\"kind\": \"AMOUNT\", \"amountCents\": 5000", 10)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:coupon-code-taken"));
        String paused = this.json.readTree(this.mvc.perform(get("/v1/coupons").param("showId", show.id().toString())
                .header("Authorization", producer())).andReturn().getResponse().getContentAsString())
                .get("items").get(0).get("id").asString();
        this.mvc.perform(post("/v1/coupons/{id}/pause", paused).header("Authorization", producer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("PAUSED"));

        UUID reservation = hold("cupom-errado", show, 1);
        quote("cupom-errado", reservation, "NAOEXISTE")
                .andExpect(status().is(422))
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:coupon-invalid"))
                .andExpect(jsonPath("$.reason").value("NOT_FOUND"));
        place("cupom-errado", reservation, "PAUSADO", 422);
        quote("cupom-errado", reservation, "PAUSADO").andExpect(jsonPath("$.reason").value("PAUSED"));

        // Cupom de outro setor.
        String sector = UUID.randomUUID().toString();
        createCoupon(show, "SOCAMAROTE", "\"kind\": \"PERCENT\", \"percent\": 50, \"sectorIds\": [\"" + sector + "\"]",
                10).andExpect(status().isCreated());
        quote("cupom-errado", reservation, "SOCAMAROTE").andExpect(jsonPath("$.reason").value("WRONG_SECTOR"));

        // Só o dono do show cria cupons nele, e comprador não cria cupom nenhum.
        this.mvc.perform(post("/v1/coupons").header("Authorization", "Bearer " + neighbours.token("outro", "producer"))
                .header("Idempotency-Key", UUID.randomUUID().toString()).contentType(MediaType.APPLICATION_JSON)
                .content(couponBody(show, "INTRUSO", "\"kind\": \"PERCENT\", \"percent\": 10", 1)))
                .andExpect(status().isNotFound());
        this.mvc.perform(post("/v1/coupons").header("Authorization", token("cupom-errado"))
                .header("Idempotency-Key", UUID.randomUUID().toString()).contentType(MediaType.APPLICATION_JSON)
                .content(couponBody(show, "COMPRADOR", "\"kind\": \"PERCENT\", \"percent\": 10", 1)))
                .andExpect(status().isForbidden());
    }

    @Test
    void limiteDoCupomNuncaEUltrapassadoMesmoComCompradoresSimultaneos() throws Exception {
        Show show = show("BUYER", Duration.ofDays(30));
        createCoupon(show, "TRES", "\"kind\": \"AMOUNT\", \"amountCents\": 1000", 3).andExpect(status().isCreated());
        List<UUID> reservations = new java.util.ArrayList<>();
        for (int i = 0; i < 12; i++) {
            reservations.add(hold("disputa-" + i, show, 1));
        }

        var results = Concurrently.run(12, i -> this.mvc.perform(post("/v1/orders")
                .header("Authorization", token("disputa-" + i))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"reservationId\": \"%s\", \"couponCode\": \"TRES\"}".formatted(reservations.get(i))))
                .andReturn().getResponse().getStatus());

        assertThat(results).allMatch(Concurrently.Result::succeeded);
        assertThat(results.stream().filter(result -> result.value() == 201)).hasSize(3);
        assertThat(results.stream().filter(result -> result.value() == 422)).hasSize(9);
        assertThat(this.jdbc.sql("SELECT uses FROM coupons WHERE show_id = :show AND code = 'TRES'")
                .param("show", show.id()).query(Integer.class).single()).isEqualTo(3);
        assertThat(this.jdbc.sql("SELECT count(*) FROM orders WHERE show_id = :show").param("show", show.id())
                .query(Integer.class).single()).isEqualTo(3);
    }

    @Test
    void compraRecusadaDevolveOUsoDoCupom() throws Exception {
        Show show = show("BUYER", Duration.ofDays(30));
        createCoupon(show, "UNICO", "\"kind\": \"PERCENT\", \"percent\": 100", 1).andExpect(status().isCreated());
        UUID reservation = hold("recusado", show, 1);
        UUID orderId = place("recusado", reservation, "UNICO", 201);
        assertThat(usesOf(show, "UNICO")).isEqualTo(1);

        counterparts.await("AuthorizePayment", orderId);
        counterparts.payment("PaymentDeclined", orderId, 0);
        published("ReleaseReservation", orderId);
        counterparts.reservation("ReservationReleased", reservation, show.id(), "RELEASED");
        awaitStatus(orderId, "CANCELLED");

        assertThat(usesOf(show, "UNICO")).isZero();
        // O uso voltou: outra pessoa consegue usar o cupom.
        place("outro-comprador", hold("outro-comprador", show, 1), "UNICO", 201);
    }

    // ------------------------------------------------ cancelamento pelo comprador

    @Test
    void compradorCancelaEOReembolsoDevolveIngressosPagamentoECupom() throws Exception {
        Show show = show("BUYER", Duration.ofDays(30));
        createCoupon(show, "VOLTA", "\"kind\": \"AMOUNT\", \"amountCents\": 2000", 1).andExpect(status().isCreated());
        UUID reservation = hold("desistiu", show, 2);
        UUID orderId = place("desistiu", reservation, "VOLTA", 201);
        long total = 2 * PRICE - 2_000 + 2 * PRICE / 10;
        confirm(orderId, reservation, show);

        this.mvc.perform(get("/v1/orders/{id}", orderId).header("Authorization", token("desistiu")))
                .andExpect(jsonPath("$.cancellation.allowed").value(true))
                .andExpect(jsonPath("$.cancellation.deadline").isNotEmpty())
                .andExpect(jsonPath("$.couponCode").value("VOLTA"));

        cancel("desistiu", orderId)
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("REFUNDING"))
                .andExpect(jsonPath("$.tickets[*].status").value(org.hamcrest.Matchers.contains("CANCELLED",
                        "CANCELLED")));
        this.relay.publishPending();
        JsonNode cancelled = counterparts.await("TicketsCancelled", orderId).payload();
        assertThat(cancelled.get("ticketIds")).hasSize(2);
        assertThat(cancelled.get("reason").asString()).isEqualTo("ORDER_CANCELLED");
        JsonNode refund = counterparts.await("RefundPayment", orderId).payload();
        assertThat(refund.get("amountCents").asLong()).isEqualTo(total);
        assertThat(refund.get("reason").asString()).isEqualTo("ORDER_CANCELLED");
        assertThat(counterparts.await("ReturnTickets", orderId).payload().get("reservationId").asString())
                .isEqualTo(reservation.toString());

        // Repetir o pedido de cancelamento é seguro: nada é enviado de novo.
        cancel("desistiu", orderId).andExpect(status().isAccepted());
        this.relay.publishPending();

        counterparts.payment("PaymentRefunded", orderId, total);
        awaitStatus(orderId, "REFUNDED");
        this.relay.publishPending();
        JsonNode refunded = counterparts.await("OrderRefunded", orderId).payload();
        assertThat(refunded.get("refundedCents").asLong()).isEqualTo(total);
        assertThat(refunded.get("couponCode").asString()).isEqualTo("VOLTA");
        assertThat(counterparts.count("RefundPayment", orderId)).isEqualTo(1);
        assertThat(usesOf(show, "VOLTA")).isZero();
        this.mvc.perform(get("/v1/orders/{id}", orderId).header("Authorization", token("desistiu")))
                .andExpect(jsonPath("$.status").value("REFUNDED"))
                .andExpect(jsonPath("$.refundedCents").value(total))
                .andExpect(jsonPath("$.refundedAt").isNotEmpty())
                .andExpect(jsonPath("$.cancellation.allowed").value(false))
                .andExpect(jsonPath("$.cancellation.reason").value("NOT_CONFIRMED"));
        // Outra pessoa não cancela o pedido.
        cancel("intrometido", orderId).andExpect(status().isNotFound());
    }

    @Test
    void cancelamentoForaDasRegrasERecusadoComOMotivo() throws Exception {
        // Pendente: ainda não há o que cancelar.
        Show farAway = show("BUYER", Duration.ofDays(60));
        UUID pendingReservation = hold("pendente", farAway, 1);
        UUID pending = place("pendente", pendingReservation, null, 201);
        cancel("pendente", pending)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:cancellation-not-allowed"))
                .andExpect(jsonPath("$.reason").value("NOT_CONFIRMED"));

        // Menos de 48 h para o show.
        Show tomorrow = show("BUYER", Duration.ofHours(24));
        UUID lateReservation = hold("em-cima-da-hora", tomorrow, 1);
        UUID late = place("em-cima-da-hora", lateReservation, null, 201);
        confirm(late, lateReservation, tomorrow);
        this.mvc.perform(get("/v1/orders/{id}", late).header("Authorization", token("em-cima-da-hora")))
                .andExpect(jsonPath("$.cancellation.allowed").value(false))
                .andExpect(jsonPath("$.cancellation.reason").value("TOO_CLOSE_TO_SHOW"));
        cancel("em-cima-da-hora", late).andExpect(jsonPath("$.reason").value("TOO_CLOSE_TO_SHOW"));

        // Mais de 7 dias depois da compra.
        UUID oldReservation = hold("arrependido-tarde", farAway, 1);
        UUID old = place("arrependido-tarde", oldReservation, null, 201);
        confirm(old, oldReservation, farAway);
        this.clock.advance(Duration.ofDays(8));
        cancel("arrependido-tarde", old).andExpect(jsonPath("$.reason").value("WINDOW_EXPIRED"));
        this.clock.reset();

        // Ingresso usado na portaria.
        UUID usedReservation = hold("ja-entrou", farAway, 2);
        UUID used = place("ja-entrou", usedReservation, null, 201);
        confirm(used, usedReservation, farAway);
        UUID ticket = this.jdbc.sql("SELECT id FROM tickets WHERE order_id = :id ORDER BY position LIMIT 1")
                .param("id", used).query(UUID.class).single();
        Instant entry = Instant.parse("2026-12-16T22:31:00Z");
        CatalogFeed.checkedIn(ticket, farAway.id(), used, farAway.sector(), "Portão B", entry);
        Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> "USED".equals(this.jdbc
                .sql("SELECT status FROM tickets WHERE id = :id").param("id", ticket).query(String.class).single()));
        this.mvc.perform(get("/v1/orders/{id}", used).header("Authorization", token("ja-entrou")))
                .andExpect(jsonPath("$.tickets[0].status").value("USED"))
                .andExpect(jsonPath("$.tickets[0].gate").value("Portão B"))
                .andExpect(jsonPath("$.tickets[0].usedAt").value("2026-12-16T22:31:00Z"))
                .andExpect(jsonPath("$.tickets[1].status").value("VALID"))
                .andExpect(jsonPath("$.cancellation.reason").value("TICKET_USED"));
        cancel("ja-entrou", used).andExpect(status().isConflict()).andExpect(jsonPath("$.reason").value("TICKET_USED"));
        // A mesma entrada repetida não muda nada.
        CatalogFeed.checkedIn(ticket, farAway.id(), used, farAway.sector(), "Portão C", entry.plusSeconds(60));
        Awaitility.await().pollDelay(Duration.ofSeconds(1)).atMost(Duration.ofSeconds(5)).until(() -> true);
        assertThat(this.jdbc.sql("SELECT gate FROM tickets WHERE id = :id").param("id", ticket).query(String.class)
                .single()).isEqualTo("Portão B");
    }

    // ------------------------------------------------------ falhas do estorno

    @Test
    void estornoQueFalhaCincoVezesVaiParaTratamentoManualEOProdutorReprocessa() throws Exception {
        Show show = show("BUYER", Duration.ofDays(30));
        UUID reservation = hold("estorno-dificil", show, 1);
        UUID orderId = place("estorno-dificil", reservation, null, 201);
        long total = PRICE + PRICE / 10;
        confirm(orderId, reservation, show);
        cancel("estorno-dificil", orderId).andExpect(status().isAccepted());
        this.relay.publishPending();
        counterparts.await("RefundPayment", orderId);

        // Uma falha: o estorno é pedido de novo quando o prazo vence.
        counterparts.payment("RefundFailed", orderId, total);
        Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> failuresOf(orderId) == 1);
        this.refundJob.resendOverdue();
        this.relay.publishPending();
        assertThat(counterparts.count("RefundPayment", orderId)).isEqualTo(1);
        this.clock.advance(Duration.ofSeconds(21));
        this.refundJob.resendOverdue();
        this.relay.publishPending();
        Awaitility.await().atMost(Duration.ofSeconds(10))
                .until(() -> counterparts.count("RefundPayment", orderId) == 2);

        for (int failure = 2; failure <= 5; failure++) {
            counterparts.payment("RefundFailed", orderId, total);
            int expected = failure;
            Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> failuresOf(orderId) == expected);
        }
        awaitStatus(orderId, "REFUND_FAILED");
        this.relay.publishPending();
        assertThat(counterparts.await("OrderRefundFailed", orderId).payload().get("attempts").asInt()).isEqualTo(5);

        this.mvc.perform(get("/v1/orders/refund-failed").param("showId", show.id().toString())
                .header("Authorization", producer()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[0].id").value(orderId.toString()))
                .andExpect(jsonPath("$.items[0].totalCents").value(total))
                .andExpect(jsonPath("$.items[0].tickets").value(1))
                .andExpect(jsonPath("$.nextCursor").doesNotExist());
        // Outro produtor não vê nem reprocessa; o comprador também não.
        String other = "Bearer " + neighbours.token("outro-produtor", "producer");
        this.mvc.perform(get("/v1/orders/refund-failed").param("showId", show.id().toString())
                .header("Authorization", other)).andExpect(status().isNotFound());
        this.mvc.perform(post("/v1/orders/{id}/refund/retry", orderId).header("Authorization", other))
                .andExpect(status().isNotFound());
        this.mvc.perform(post("/v1/orders/{id}/refund/retry", orderId).header("Authorization", token("estorno-dificil")))
                .andExpect(status().isForbidden());

        this.mvc.perform(post("/v1/orders/{id}/refund/retry", orderId).header("Authorization", producer()))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("REFUNDING"));
        this.relay.publishPending();
        Awaitility.await().atMost(Duration.ofSeconds(10))
                .until(() -> counterparts.count("RefundPayment", orderId) == 3);
        counterparts.payment("PaymentRefunded", orderId, total);
        awaitStatus(orderId, "REFUNDED");
    }

    // ------------------------------------------------------------ show cancelado

    @Test
    void showCanceladoReembolsaTodosOsPedidosComControleDeVazao() throws Exception {
        Show show = show("BUYER", Duration.ofDays(30));
        List<UUID> confirmed = new java.util.ArrayList<>();
        for (int i = 0; i < 3; i++) {
            UUID reservation = hold("fa-" + i, show, 1);
            UUID orderId = place("fa-" + i, reservation, null, 201);
            confirm(orderId, reservation, show);
            confirmed.add(orderId);
        }
        // Um pedido no meio da saga quando o show é cancelado.
        UUID lateReservation = hold("fa-atrasado", show, 1);
        UUID late = place("fa-atrasado", lateReservation, null, 201);
        counterparts.await("AuthorizePayment", late);

        CatalogFeed.show(show.id(), 3, PRODUCER, "CANCELLED", Instant.now().plus(Duration.ofDays(30)), "BUYER");
        Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> refundsOf(show, "QUEUED") == 3);

        // Vazão de 2 por rodada.
        this.refundJob.run();
        assertThat(refundsOf(show, "REFUNDING")).isEqualTo(2);
        assertThat(refundsOf(show, "QUEUED")).isEqualTo(1);
        this.refundJob.run();
        assertThat(refundsOf(show, "REFUNDING")).isEqualTo(3);
        this.relay.publishPending();
        for (UUID orderId : confirmed) {
            assertThat(counterparts.await("RefundPayment", orderId).payload().get("reason").asString())
                    .isEqualTo("SHOW_CANCELLED");
            assertThat(counterparts.await("TicketsCancelled", orderId).payload().get("reason").asString())
                    .isEqualTo("SHOW_CANCELLED");
            assertThat(counterparts.count("ReturnTickets", orderId)).isZero();
        }

        // O pedido que confirma depois do cancelamento também é reembolsado.
        counterparts.payment("PaymentAuthorized", late, PRICE + PRICE / 10);
        published("ConfirmReservation", late);
        counterparts.reservation("ReservationConfirmed", lateReservation, show.id(), null);
        awaitStatus(late, "CONFIRMED");
        this.refundJob.run();
        this.relay.publishPending();
        assertThat(counterparts.await("RefundPayment", late).payload().get("reason").asString())
                .isEqualTo("SHOW_CANCELLED");

        for (UUID orderId : confirmed) {
            counterparts.payment("PaymentRefunded", orderId, PRICE + PRICE / 10);
            awaitStatus(orderId, "REFUNDED");
        }
        // A mesma versão do show entregue de novo não põe ninguém na fila outra vez.
        CatalogFeed.show(show.id(), 3, PRODUCER, "CANCELLED", Instant.now().plus(Duration.ofDays(30)), "BUYER");
        this.refundJob.run();
        assertThat(refundsOf(show, "COMPLETED")).isEqualTo(3);
    }

    @Test
    void todoOOutboxPublicadoPassaNoContrato() {
        this.relay.publishPending();
        this.jdbc.sql("SELECT topic, type, envelope::text FROM outbox")
                .query((rs, row) -> new String[] { rs.getString(1), rs.getString(2), rs.getString(3) })
                .list()
                .forEach(message -> Contracts.assertValid(message[0], message[1], message[2]));
    }

    // ------------------------------------------------------------------ apoio

    private record Show(UUID id, UUID sector) {
    }

    /** Um show à venda na cópia local do catálogo, do produtor dos testes. */
    private Show show(String feePaidBy, Duration startsIn) {
        UUID id = UUID.randomUUID();
        CatalogFeed.show(id, 2, PRODUCER, "ON_SALE", Instant.now().plus(startsIn), feePaidBy);
        Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> this.jdbc
                .sql("SELECT count(*) FROM shows WHERE id = :id").param("id", id).query(Integer.class).single() == 1);
        return new Show(id, UUID.randomUUID());
    }

    private UUID hold(String buyer, Show show, int quantity) {
        return inventory.hold(buyer, show.id(), show.sector(), Collections.nCopies(quantity, null), PRICE);
    }

    private String couponBody(Show show, String code, String discount, int maxUses) {
        return """
                {"showId": "%s", "code": "%s", %s, "maxUses": %d, "validUntil": "%s"}
                """.formatted(show.id(), code, discount, maxUses, Instant.now().plus(Duration.ofDays(20)));
    }

    private ResultActions createCoupon(Show show, String code, String discount, int maxUses) throws Exception {
        return this.mvc.perform(post("/v1/coupons")
                .header("Authorization", producer())
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(couponBody(show, code, discount, maxUses)));
    }

    private ResultActions quote(String buyer, UUID reservation, String coupon) throws Exception {
        return this.mvc.perform(post("/v1/orders/quote")
                .header("Authorization", token(buyer))
                .contentType(MediaType.APPLICATION_JSON)
                .content(body(reservation, coupon)));
    }

    private UUID place(String buyer, UUID reservation, String coupon, int expectedStatus) throws Exception {
        String response = this.mvc.perform(post("/v1/orders")
                .header("Authorization", token(buyer))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content(body(reservation, coupon)))
                .andExpect(status().is(expectedStatus))
                .andReturn().getResponse().getContentAsString();
        this.relay.publishPending();
        return expectedStatus == 201 ? UUID.fromString(this.json.readTree(response).get("id").asString()) : null;
    }

    private static String body(UUID reservation, String coupon) {
        return coupon == null ? "{\"reservationId\": \"%s\"}".formatted(reservation)
                : "{\"reservationId\": \"%s\", \"couponCode\": \"%s\"}".formatted(reservation, coupon);
    }

    private ResultActions cancel(String buyer, UUID orderId) throws Exception {
        return this.mvc.perform(post("/v1/orders/{id}/cancel", orderId).header("Authorization", token(buyer)));
    }

    /** Pagamento aprovado e reserva confirmada: o pedido fica CONFIRMED, com os ingressos emitidos. */
    private void confirm(UUID orderId, UUID reservation, Show show) {
        JsonNode authorize = counterparts.await("AuthorizePayment", orderId).payload();
        counterparts.payment("PaymentAuthorized", orderId, authorize.get("amountCents").asLong());
        published("ConfirmReservation", orderId);
        counterparts.reservation("ReservationConfirmed", reservation, show.id(), null);
        awaitStatus(orderId, "CONFIRMED");
    }

    /** Espera o order-service publicar a mensagem, publicando o outbox enquanto isso. */
    private void published(String type, UUID orderId) {
        Awaitility.await().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(50)).until(() -> {
            this.relay.publishPending();
            return counterparts.count(type, orderId) > 0;
        });
    }

    /** Espera o pedido chegar ao estado, publicando o outbox enquanto isso (o relay está desligado). */
    private void awaitStatus(UUID orderId, String status) {
        Awaitility.await().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(50)).until(() -> {
            this.relay.publishPending();
            return status.equals(this.jdbc.sql("SELECT status FROM orders WHERE id = :id").param("id", orderId)
                    .query(String.class).single());
        });
        this.relay.publishPending();
    }

    private int usesOf(Show show, String code) {
        return this.jdbc.sql("SELECT uses FROM coupons WHERE show_id = :show AND code = :code")
                .param("show", show.id()).param("code", code).query(Integer.class).single();
    }

    private int failuresOf(UUID orderId) {
        return this.jdbc.sql("SELECT failures FROM refunds WHERE order_id = :id").param("id", orderId)
                .query(Integer.class).single();
    }

    private int refundsOf(Show show, String status) {
        return this.jdbc.sql("""
                SELECT count(*) FROM refunds r JOIN orders o ON o.id = r.order_id
                WHERE o.show_id = :show AND r.status = :status
                """).param("show", show.id()).param("status", status).query(Integer.class).single();
    }

    private String token(String buyer) {
        return "Bearer " + neighbours.token(buyer, "buyer");
    }

    private String producer() {
        return "Bearer " + neighbours.token(PRODUCER, "producer");
    }
}

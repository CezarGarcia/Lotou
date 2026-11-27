package br.com.lotou.order.saga;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.messaging.OutboxRelay;
import br.com.lotou.order.support.CatalogFeed;
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

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * A saga de compra pelo Kafka de verdade, com dublês dos outros participantes: o payment-mock e
 * o inventory são feitos pelo {@link SagaCounterparts}, e a leitura síncrona da reserva pelo
 * {@link InventoryStub}. Cada mensagem trocada é conferida contra contracts/.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(TestBeans.class)
class PurchaseSagaTests {

    private static final Neighbours neighbours = EndToEndEnvironment.NEIGHBOURS;
    private static final InventoryStub inventory = InventoryStub.start();
    private static final SagaCounterparts counterparts = SagaCounterparts.start();
    private static final long PRICE = 12_000;

    @Autowired
    private MockMvc mvc;

    @Autowired
    private OutboxRelay relay;

    @Autowired
    private SagaDeadlineJob deadlines;

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

    // ------------------------------------------------------------ caminho feliz

    @Test
    void pagamentoAprovadoConfirmaAReservaEEmiteOsIngressos() throws Exception {
        Purchase purchase = buy("comprador-feliz", List.of("A-1", "A-2"));
        assertThat(statusOf(purchase.orderId())).isEqualTo("PENDING");

        JsonNode authorize = counterparts.await("AuthorizePayment", purchase.orderId()).payload();
        // Os ingressos mais a taxa de serviço de 10%, que neste show o comprador paga.
        assertThat(authorize.get("amountCents").asLong()).isEqualTo(2 * PRICE + 2 * PRICE / 10);
        assertThat(authorize.get("buyerId").asString()).isEqualTo("comprador-feliz");

        counterparts.payment("PaymentAuthorized", purchase.orderId(), 2 * PRICE);
        awaitStep(purchase.orderId(), "CONFIRMING_RESERVATION");
        JsonNode confirm = counterparts.await("ConfirmReservation", purchase.orderId()).payload();
        assertThat(confirm.get("reservationId").asString()).isEqualTo(purchase.reservationId().toString());

        counterparts.reservation("ReservationConfirmed", purchase.reservationId(), purchase.showId(), null);
        awaitStep(purchase.orderId(), "COMPLETED");

        assertThat(statusOf(purchase.orderId())).isEqualTo("CONFIRMED");
        assertThat(ticketsOf(purchase.orderId())).isEqualTo(2);
        JsonNode issued = counterparts.await("TicketsIssued", purchase.orderId()).payload();
        assertThat(issued.get("tickets")).hasSize(2);
        counterparts.await("OrderConfirmed", purchase.orderId());
        // Tópicos diferentes podem chegar ao leitor em qualquer ordem; a ordem por tópico é a da saga.
        assertThat(counterparts.typesFor(purchase.orderId())).containsExactlyInAnyOrder("OrderCreated", "AuthorizePayment",
                "ConfirmReservation", "OrderConfirmed", "TicketsIssued");
        this.mvc.perform(get("/v1/orders/{id}", purchase.orderId()).header("Authorization", token("comprador-feliz")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.tickets.length()").value(2));
    }

    // ------------------------------------------------------------- compensação

    @Test
    void pagamentoRecusadoLiberaAReservaECancelaOPedido() throws Exception {
        Purchase purchase = buy("comprador-recusado", List.of("B-1"));
        counterparts.await("AuthorizePayment", purchase.orderId());

        counterparts.payment("PaymentDeclined", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "RELEASING_RESERVATION");
        JsonNode release = counterparts.await("ReleaseReservation", purchase.orderId()).payload();
        assertThat(release.get("reason").asString()).isEqualTo("PAYMENT_DECLINED");

        counterparts.reservation("ReservationReleased", purchase.reservationId(), purchase.showId(), "RELEASED");
        awaitStep(purchase.orderId(), "COMPENSATED");

        assertThat(statusOf(purchase.orderId())).isEqualTo("CANCELLED");
        assertThat(cancelReasonOf(purchase.orderId())).isEqualTo("PAYMENT_DECLINED");
        assertThat(ticketsOf(purchase.orderId())).isZero();
        JsonNode cancelled = counterparts.await("OrderCancelled", purchase.orderId()).payload();
        assertThat(cancelled.get("reason").asString()).isEqualTo("PAYMENT_DECLINED");
    }

    @Test
    void reservaQueExpiraDuranteOPagamentoTemOPagamentoEstornado() throws Exception {
        Purchase purchase = buy("comprador-lento", List.of("C-1"));
        counterparts.await("AuthorizePayment", purchase.orderId());

        // O inventory devolve os ingressos à venda antes de o pagamento responder.
        counterparts.reservation("ReservationReleased", purchase.reservationId(), purchase.showId(), "EXPIRED");
        Awaitility.await().atMost(Duration.ofSeconds(10)).until(() -> reservationLost(purchase.orderId()));

        counterparts.payment("PaymentAuthorized", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "REFUNDING_PAYMENT");
        JsonNode refund = counterparts.await("RefundPayment", purchase.orderId()).payload();
        assertThat(refund.get("reason").asString()).isEqualTo("RESERVATION_EXPIRED");
        assertThat(counterparts.count("ConfirmReservation", purchase.orderId())).isZero();

        counterparts.payment("PaymentRefunded", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "COMPENSATED");
        assertThat(statusOf(purchase.orderId())).isEqualTo("CANCELLED");
        assertThat(cancelReasonOf(purchase.orderId())).isEqualTo("RESERVATION_EXPIRED");
        assertThat(paymentStatusOf(purchase.orderId())).isEqualTo("REFUNDED");
    }

    @Test
    void reservaQueExpiraAntesDeSerConfirmadaTemOPagamentoEstornado() throws Exception {
        Purchase purchase = buy("comprador-atrasado", List.of("D-1"));
        counterparts.await("AuthorizePayment", purchase.orderId());
        counterparts.payment("PaymentAuthorized", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "CONFIRMING_RESERVATION");

        counterparts.reservation("ReservationReleased", purchase.reservationId(), purchase.showId(), "EXPIRED");
        awaitStep(purchase.orderId(), "REFUNDING_PAYMENT");
        counterparts.await("RefundPayment", purchase.orderId());

        counterparts.payment("PaymentRefunded", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "COMPENSATED");
        assertThat(cancelReasonOf(purchase.orderId())).isEqualTo("RESERVATION_EXPIRED");
    }

    @Test
    void cadeiraJaVendidaParaOutroPedidoNaoEmiteIngressoEEstornaOPagamento() throws Exception {
        UUID show = UUID.randomUUID();
        UUID sector = UUID.randomUUID();
        Purchase first = buy("primeiro", show, sector, List.of("E-1"));
        complete(first);

        // Uma segunda reserva para a mesma cadeira, que nunca deveria existir: a última defesa barra.
        Purchase second = buy("segundo", show, sector, List.of("E-1"));
        counterparts.await("AuthorizePayment", second.orderId());
        counterparts.payment("PaymentAuthorized", second.orderId(), PRICE);
        awaitStep(second.orderId(), "CONFIRMING_RESERVATION");
        counterparts.reservation("ReservationConfirmed", second.reservationId(), show, null);

        awaitStep(second.orderId(), "REFUNDING_PAYMENT");
        assertThat(counterparts.await("RefundPayment", second.orderId()).payload().get("reason").asString())
                .isEqualTo("TICKET_CONFLICT");
        assertThat(ticketsOf(second.orderId())).isZero();
    }

    // ------------------------------------------------------- mensagens repetidas

    @Test
    void respostaRepetidaOuForaDoPassoNaoMudaNada() throws Exception {
        Purchase purchase = buy("comprador-repetido", List.of("F-1"));
        counterparts.await("AuthorizePayment", purchase.orderId());

        UUID authorized = counterparts.payment("PaymentAuthorized", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "CONFIRMING_RESERVATION");
        JsonNode payload = this.json.readTree(Contracts.example("payment.events", "PaymentAuthorized")).get("payload");
        ((tools.jackson.databind.node.ObjectNode) payload).put("orderId", purchase.orderId().toString());
        // A mesma mensagem entregue de novo, e uma recusa que chega depois da aprovação.
        counterparts.redeliver("payment.events", purchase.orderId().toString(), authorized, "PaymentAuthorized",
                payload);
        counterparts.payment("PaymentDeclined", purchase.orderId(), PRICE);
        counterparts.reservation("ReservationConfirmed", purchase.reservationId(), purchase.showId(), null);
        awaitStep(purchase.orderId(), "COMPLETED");

        assertThat(counterparts.count("ConfirmReservation", purchase.orderId())).isEqualTo(1);
        assertThat(counterparts.count("ReleaseReservation", purchase.orderId())).isZero();
        assertThat(statusOf(purchase.orderId())).isEqualTo("CONFIRMED");
        assertThat(ticketsOf(purchase.orderId())).isEqualTo(1);
    }

    @Test
    void mensagemMalformadaVaiParaADltEOConsumidorSegue() throws Exception {
        counterparts.raw("payment.events", UUID.randomUUID().toString(), "isto não é JSON");
        // O consumidor não para: a compra seguinte anda normalmente.
        Purchase purchase = buy("depois-do-lixo", List.of("G-1"));
        complete(purchase);
        assertThat(statusOf(purchase.orderId())).isEqualTo("CONFIRMED");
    }

    // ---------------------------------------------------------- prazos vencidos

    @Test
    void semRespostaDoPagamentoOComandoERepetidoQuandoOPrazoVence() throws Exception {
        Purchase purchase = buy("pagamento-sumiu", List.of("H-1"));
        counterparts.await("AuthorizePayment", purchase.orderId());

        this.deadlines.resumeOverdue();
        this.relay.publishPending();
        assertThat(counterparts.count("AuthorizePayment", purchase.orderId())).isEqualTo(1);

        this.clock.advance(Duration.ofSeconds(11));
        this.deadlines.resumeOverdue();
        this.relay.publishPending();
        Awaitility.await().atMost(Duration.ofSeconds(10))
                .until(() -> counterparts.count("AuthorizePayment", purchase.orderId()) == 2);
        assertThat(attemptsOf(purchase.orderId())).isEqualTo(2);

        counterparts.payment("PaymentAuthorized", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "CONFIRMING_RESERVATION");
    }

    @Test
    void confirmacaoQueNaoChegouEDescobertaConsultandoAReserva() throws Exception {
        Purchase purchase = buy("fato-perdido", List.of("I-1"));
        counterparts.await("AuthorizePayment", purchase.orderId());
        counterparts.payment("PaymentAuthorized", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "CONFIRMING_RESERVATION");

        // O inventory confirmou, mas o fato não chegou: o job consulta a reserva quando o prazo vence.
        inventory.confirm(purchase.reservationId());
        this.clock.advance(Duration.ofSeconds(11));
        this.deadlines.resumeOverdue();

        assertThat(stepOf(purchase.orderId())).isEqualTo("COMPLETED");
        assertThat(statusOf(purchase.orderId())).isEqualTo("CONFIRMED");
    }

    @Test
    void reservaExpiradaDescobertaPeloPrazoLevaAoEstorno() throws Exception {
        Purchase purchase = buy("expirou-calada", List.of("J-1"));
        counterparts.await("AuthorizePayment", purchase.orderId());
        counterparts.payment("PaymentAuthorized", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "CONFIRMING_RESERVATION");

        inventory.expire(purchase.reservationId());
        this.clock.advance(Duration.ofSeconds(11));
        this.deadlines.resumeOverdue();

        assertThat(stepOf(purchase.orderId())).isEqualTo("REFUNDING_PAYMENT");
        this.relay.publishPending();
        counterparts.await("RefundPayment", purchase.orderId());
    }

    // --------------------------------------------------------------- entrada

    @Test
    void mesmaIdempotencyKeyDevolveOMesmoPedidoSemComecarOutraSaga() throws Exception {
        UUID show = UUID.randomUUID();
        inCatalog(show);
        UUID reservation = inventory.hold("comprador-duplo", show, UUID.randomUUID(), List.of("K-1"), PRICE);
        String key = UUID.randomUUID().toString();
        String first = place("comprador-duplo", reservation, key, 201);
        String second = place("comprador-duplo", reservation, key, 201);
        assertThat(second).isEqualTo(first);
        this.relay.publishPending();
        UUID orderId = UUID.fromString(first);
        counterparts.await("AuthorizePayment", orderId);
        assertThat(counterparts.count("OrderCreated", orderId)).isEqualTo(1);
    }

    @Test
    void todoOOutboxPublicadoPassaNoContrato() {
        this.relay.publishPending();
        List<String[]> published = this.jdbc.sql("SELECT topic, type, envelope::text FROM outbox")
                .query((rs, row) -> new String[] { rs.getString(1), rs.getString(2), rs.getString(3) })
                .list();
        published.forEach(message -> Contracts.assertValid(message[0], message[1], message[2]));
    }

    // ------------------------------------------------------------------ apoio

    private record Purchase(UUID orderId, UUID reservationId, UUID showId) {
    }

    private Purchase buy(String buyer, List<String> seats) throws Exception {
        return buy(buyer, UUID.randomUUID(), UUID.randomUUID(), seats);
    }

    private Purchase buy(String buyer, UUID show, UUID sector, List<String> seats) throws Exception {
        inCatalog(show);
        UUID reservation = inventory.hold(buyer, show, sector, seats, PRICE);
        UUID orderId = UUID.fromString(place(buyer, reservation, UUID.randomUUID().toString(), 201));
        this.relay.publishPending();
        return new Purchase(orderId, reservation, show);
    }

    /** O show na cópia local do catálogo, como o event-service o publicaria: o checkout precisa dele. */
    private void inCatalog(UUID show) {
        CatalogFeed.show(show, 2, "produtor-1", "ON_SALE", java.time.Instant.now().plus(Duration.ofDays(30)), "BUYER");
        Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> this.jdbc
                .sql("SELECT count(*) FROM shows WHERE id = :id").param("id", show).query(Integer.class).single() == 1);
    }

    /** Pagamento aprovado e reserva confirmada: a saga termina com o pedido confirmado. */
    private void complete(Purchase purchase) {
        counterparts.await("AuthorizePayment", purchase.orderId());
        counterparts.payment("PaymentAuthorized", purchase.orderId(), PRICE);
        awaitStep(purchase.orderId(), "CONFIRMING_RESERVATION");
        counterparts.reservation("ReservationConfirmed", purchase.reservationId(), purchase.showId(), null);
        awaitStep(purchase.orderId(), "COMPLETED");
    }

    private String place(String buyer, UUID reservation, String key, int expectedStatus) throws Exception {
        String body = this.mvc.perform(post("/v1/orders")
                .header("Authorization", token(buyer))
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"reservationId\": \"%s\"}".formatted(reservation)))
                .andExpect(status().is(expectedStatus))
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andReturn().getResponse().getContentAsString();
        return this.json.readTree(body).get("id").asString();
    }

    /** Espera a saga chegar ao passo, publicando o outbox enquanto isso (o relay está desligado). */
    private void awaitStep(UUID orderId, String step) {
        Awaitility.await().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(50)).until(() -> {
            this.relay.publishPending();
            return step.equals(stepOf(orderId));
        });
        this.relay.publishPending();
    }

    private String token(String buyer) {
        return "Bearer " + neighbours.token(buyer, "buyer");
    }

    private String stepOf(UUID orderId) {
        return this.jdbc.sql("SELECT step FROM saga_state WHERE order_id = :id").param("id", orderId)
                .query(String.class).single();
    }

    private int attemptsOf(UUID orderId) {
        return this.jdbc.sql("SELECT attempts FROM saga_state WHERE order_id = :id").param("id", orderId)
                .query(Integer.class).single();
    }

    private boolean reservationLost(UUID orderId) {
        return this.jdbc.sql("SELECT reservation_lost FROM saga_state WHERE order_id = :id").param("id", orderId)
                .query(Boolean.class).single();
    }

    private String statusOf(UUID orderId) {
        return this.jdbc.sql("SELECT status FROM orders WHERE id = :id").param("id", orderId).query(String.class)
                .single();
    }

    private String cancelReasonOf(UUID orderId) {
        return this.jdbc.sql("SELECT cancel_reason FROM orders WHERE id = :id").param("id", orderId)
                .query(String.class).single();
    }

    private String paymentStatusOf(UUID orderId) {
        return this.jdbc.sql("SELECT payment_status FROM orders WHERE id = :id").param("id", orderId)
                .query(String.class).single();
    }

    private int ticketsOf(UUID orderId) {
        return this.jdbc.sql("SELECT count(*) FROM tickets WHERE order_id = :id").param("id", orderId)
                .query(Integer.class).single();
    }
}

package br.com.lotou.order.order;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.hasSize;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.support.Concurrently;
import br.com.lotou.order.support.ControllablePaymentGateway;
import br.com.lotou.order.support.EndToEndEnvironment;
import br.com.lotou.order.support.InventoryStub;
import br.com.lotou.order.support.InventoryStub.Mode;
import br.com.lotou.order.support.MutableClock;
import br.com.lotou.order.support.Neighbours;
import br.com.lotou.order.support.TestBeans;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * O que acontece com o pedido quando o checkout é interrompido no meio: inventory fora do ar,
 * resposta perdida, reserva que expira durante o pagamento. O inventory aqui é um stub que falha
 * sob encomenda; o caminho feliz com o inventory de verdade está em {@link CheckoutEndToEndTests}.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(TestBeans.class)
class CheckoutRecoveryTests {

    private static final Neighbours neighbours = EndToEndEnvironment.NEIGHBOURS;
    private static final InventoryStub inventory = InventoryStub.start();

    @Autowired
    private MockMvc mvc;

    @Autowired
    private OrderRecoveryJob recovery;

    @Autowired
    private ControllablePaymentGateway payments;

    @Autowired
    private MutableClock clock;

    @Autowired
    private JdbcClient jdbc;

    @DynamicPropertySource
    static void environment(DynamicPropertyRegistry registry) {
        EndToEndEnvironment.configure(registry);
        registry.add("INVENTORY_SERVICE_URL", inventory::url);
    }

    @AfterAll
    static void stopStub() {
        inventory.close();
    }

    @BeforeEach
    void reset() {
        inventory.reset();
        this.payments.reset();
        this.clock.reset();
        // Um pedido pendente deixado por outro teste não entra na conta deste.
        this.jdbc.sql("UPDATE orders SET status = 'CANCELLED', cancel_reason = 'RESERVATION_EXPIRED' WHERE status = 'PENDING'")
                .update();
    }

    /** Fecha a compra e devolve o ID do pedido criado. */
    private UUID order(String buyer, UUID reservationId, String expectedStatus) throws Exception {
        String location = this.mvc.perform(post("/v1/orders")
                .header("Authorization", "Bearer " + neighbours.token(buyer, "buyer"))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"reservationId\": \"%s\"}".formatted(reservationId)))
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value(expectedStatus))
                .andReturn().getResponse().getHeader("Location");
        return UUID.fromString(location.substring("/v1/orders/".length()));
    }

    private String statusOf(UUID orderId) {
        return this.jdbc.sql("SELECT status FROM orders WHERE id = :id").param("id", orderId).query(String.class)
                .single();
    }

    private int ticketsOf(UUID orderId) {
        return this.jdbc.sql("SELECT count(*) FROM tickets WHERE order_id = :id").param("id", orderId)
                .query(Integer.class).single();
    }

    @Test
    void inventoryForaDoArDeixaOPedidoPendenteEOJobConcluiDepoisSemCobrarDeNovo() throws Exception {
        UUID reservation = inventory.hold("ana", 2, 15_000);
        // A reserva é lida, e o inventory cai antes da confirmação.
        this.payments.reset();
        UUID orderId = orderWithInventoryFailingAfterFetch(reservation, Mode.DOWN);

        assertThat(statusOf(orderId)).isEqualTo("PENDING");
        assertThat(ticketsOf(orderId)).isZero();
        assertThat(this.payments.authorizationsOf(orderId)).isEqualTo(1);

        // Enquanto o prazo de quem processava não vence, o job não mexe no pedido.
        inventory.mode(Mode.HEALTHY);
        assertThat(this.recovery.recoverPending()).isZero();

        this.clock.advance(Duration.ofSeconds(31));
        assertThat(this.recovery.recoverPending()).isEqualTo(1);

        assertThat(statusOf(orderId)).isEqualTo("CONFIRMED");
        assertThat(ticketsOf(orderId)).isEqualTo(2);
        assertThat(inventory.statusOf(reservation)).isEqualTo("CONFIRMED");
        // O resultado do pagamento estava gravado: retomar não autoriza de novo.
        assertThat(this.payments.authorizationsOf(orderId)).isEqualTo(1);
        assertThat(this.recovery.recoverPending()).isZero();
    }

    @Test
    void respostaDaConfirmacaoPerdidaNaoDuplicaNada() throws Exception {
        UUID reservation = inventory.hold("ana", 1, 15_000);
        UUID orderId = orderWithInventoryFailingAfterFetch(reservation, Mode.CONFIRM_RESPONSE_LOST);

        // O inventory confirmou, mas o order-service não ficou sabendo.
        assertThat(inventory.statusOf(reservation)).isEqualTo("CONFIRMED");
        assertThat(statusOf(orderId)).isEqualTo("PENDING");

        inventory.mode(Mode.HEALTHY);
        this.clock.advance(Duration.ofSeconds(31));
        this.recovery.recoverPending();

        // Confirmar de novo é idempotente: o pedido conclui e os ingressos saem uma vez só.
        assertThat(statusOf(orderId)).isEqualTo("CONFIRMED");
        assertThat(ticketsOf(orderId)).isEqualTo(1);
        assertThat(inventory.calls("confirm", reservation)).isEqualTo(2);
    }

    @Test
    void variasInstanciasDoJobRetomamOPedidoUmaVezSo() throws Exception {
        UUID reservation = inventory.hold("ana", 1, 15_000);
        UUID orderId = orderWithInventoryFailingAfterFetch(reservation, Mode.DOWN);
        inventory.mode(Mode.HEALTHY);
        this.clock.advance(Duration.ofSeconds(31));

        var results = Concurrently.run(8, i -> this.recovery.recoverPending());

        assertThat(results.stream().mapToInt(Concurrently.Result::value).sum()).isEqualTo(1);
        assertThat(statusOf(orderId)).isEqualTo("CONFIRMED");
        assertThat(ticketsOf(orderId)).isEqualTo(1);
        assertThat(inventory.calls("confirm", reservation)).isEqualTo(2);
    }

    @Test
    void reservaQueExpiraDuranteOPagamentoCancelaOPedidoEDesfazACobranca() throws Exception {
        UUID reservation = inventory.hold("ana", 1, 15_000);
        // A reserva está segurada quando o pedido é criado e expira antes da confirmação.
        this.payments.onAuthorize(() -> inventory.expire(reservation));

        UUID orderId = order("ana", reservation, "CANCELLED");

        assertThat(this.jdbc.sql("SELECT cancel_reason FROM orders WHERE id = :id").param("id", orderId)
                .query(String.class).single()).isEqualTo("RESERVATION_EXPIRED");
        assertThat(ticketsOf(orderId)).isZero();
        assertThat(this.payments.voided()).containsExactly(orderId);
    }

    @Test
    void pagamentoRecusadoComReservaJaExpiradaSoCancelaOPedido() throws Exception {
        UUID reservation = inventory.hold("ana", 1, 15_000);
        this.payments.declineNext();
        this.payments.onAuthorize(() -> inventory.expire(reservation));

        UUID orderId = order("ana", reservation, "CANCELLED");

        assertThat(this.jdbc.sql("SELECT cancel_reason FROM orders WHERE id = :id").param("id", orderId)
                .query(String.class).single()).isEqualTo("PAYMENT_DECLINED");
        assertThat(inventory.statusOf(reservation)).isEqualTo("EXPIRED");
        assertThat(this.payments.voided()).isEmpty();
    }

    @Test
    void constraintDeIngressosBarraUmSegundoIngressoParaAMesmaCadeira() throws Exception {
        UUID showId = UUID.randomUUID();
        UUID sectorId = UUID.randomUUID();
        UUID first = order("ana", inventory.hold("ana", showId, sectorId, List.of("A-1", "A-2"), 30_000), "CONFIRMED");

        // O inventory nunca deixaria isso acontecer; o stub deixa, para a última defesa aparecer.
        UUID conflicting = inventory.hold("bia", showId, sectorId, List.of("A-2", "A-3"), 30_000);
        UUID second = order("bia", conflicting, "CANCELLED");

        assertThat(this.jdbc.sql("SELECT cancel_reason FROM orders WHERE id = :id").param("id", second)
                .query(String.class).single()).isEqualTo("TICKET_CONFLICT");
        assertThat(ticketsOf(first)).isEqualTo(2);
        // Nenhum ingresso do segundo pedido ficou, nem o da cadeira que estava livre.
        assertThat(ticketsOf(second)).isZero();
        assertThat(this.payments.voided()).containsExactly(second);
        assertThat(this.jdbc.sql("SELECT count(*) FROM tickets WHERE show_id = :id AND seat_label = 'A-2'")
                .param("id", showId).query(Integer.class).single()).isEqualTo(1);
    }

    @Test
    void semInventoryParaLerAReservaResponde503ENaoCriaPedido() throws Exception {
        UUID reservation = inventory.hold("ana", 1, 15_000);
        inventory.mode(Mode.DOWN);

        this.mvc.perform(post("/v1/orders")
                .header("Authorization", "Bearer " + neighbours.token("ana", "buyer"))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"reservationId\": \"%s\"}".formatted(reservation)))
                .andExpect(status().isServiceUnavailable())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:upstream-unavailable"));

        assertThat(this.jdbc.sql("SELECT count(*) FROM orders WHERE reservation_id = :id").param("id", reservation)
                .query(Integer.class).single()).isZero();
    }

    @Test
    void pedidoPendenteApareceParaOCompradorEnquantoNaoConclui() throws Exception {
        UUID reservation = inventory.hold("ana", 1, 15_000);
        UUID orderId = orderWithInventoryFailingAfterFetch(reservation, Mode.DOWN);

        this.mvc.perform(get("/v1/orders/" + orderId)
                .header("Authorization", "Bearer " + neighbours.token("ana", "buyer")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andExpect(jsonPath("$.tickets", hasSize(0)));
    }

    /** Cria o pedido com o inventory respondendo à leitura da reserva e falhando logo depois. */
    private UUID orderWithInventoryFailingAfterFetch(UUID reservation, Mode failure) throws Exception {
        this.payments.onAuthorize(() -> inventory.mode(failure));
        return order("ana", reservation, "PENDING");
    }
}

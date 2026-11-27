package br.com.lotou.order.order;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;
import static org.hamcrest.Matchers.contains;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.matchesPattern;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import br.com.lotou.order.support.Concurrently;
import br.com.lotou.order.support.Concurrently.Result;
import br.com.lotou.order.support.Cpfs;
import br.com.lotou.order.support.EndToEndEnvironment;
import br.com.lotou.order.support.InventoryApi;
import br.com.lotou.order.support.Neighbours;
import br.com.lotou.order.support.PaymentDouble;
import br.com.lotou.order.support.TestBeans;
import com.jayway.jsonpath.JsonPath;
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
import org.springframework.test.web.servlet.ResultActions;

/**
 * O checkout de ponta a ponta: o order-service de verdade e o inventory-service de verdade (a
 * imagem Docker dele), num Postgres e num Kafka reais. A saga passa pelo Kafka nos dois sentidos;
 * só o emissor de tokens, a publicação do catálogo e o pagamento ({@link PaymentDouble}) são de
 * teste.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(TestBeans.class)
class CheckoutEndToEndTests {

    private static final Neighbours neighbours = EndToEndEnvironment.NEIGHBOURS;
    private static final InventoryApi inventory = new InventoryApi(EndToEndEnvironment.Inventory.url(), neighbours);
    private static final PaymentDouble payments = PaymentDouble.start();

    @Autowired
    private MockMvc mvc;

    @Autowired
    private JdbcClient jdbc;

    @DynamicPropertySource
    static void environment(DynamicPropertyRegistry registry) {
        EndToEndEnvironment.configure(registry);
        registry.add("INVENTORY_SERVICE_URL", EndToEndEnvironment.Inventory::url);
        // Aqui o relay e o job de prazos rodam sozinhos, como em produção.
        registry.add("lotou.order.jobs.enabled", () -> "true");
        registry.add("lotou.order.jobs.outbox-interval", () -> "50ms");
    }

    @AfterAll
    static void stop() {
        payments.close();
    }

    @BeforeEach
    void approveEverything() {
        payments.declineWhen(buyer -> false);
    }

    @Test
    void compraNaPistaConfirmaOPedidoEmiteOsIngressosEVendeAReserva() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(10, 18_000));
        UUID reservation = inventory.reserve("ana", show, 2);

        String location = order("ana", reservation)
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", matchesPattern("/v1/orders/[0-9a-f-]{36}")))
                .andExpect(jsonPath("$.id", matchesPattern("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f-]+")))
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andExpect(jsonPath("$.totalCents").value(39_600))
                .andExpect(jsonPath("$.tickets", hasSize(0)))
                .andReturn().getResponse().getHeader("Location");

        awaitStatus("ana", location, "CONFIRMED");
        this.mvc.perform(get(location).header("Authorization", token("ana")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.showId").value(show.id().toString()))
                .andExpect(jsonPath("$.reservationId").value(reservation.toString()))
                .andExpect(jsonPath("$.cancelReason").value(nullValue()))
                .andExpect(jsonPath("$.confirmedAt").isNotEmpty())
                .andExpect(jsonPath("$.subtotalCents").value(36_000))
                .andExpect(jsonPath("$.serviceFeeCents").value(3_600))
                .andExpect(jsonPath("$.serviceFeePaidBy").value("BUYER"))
                .andExpect(jsonPath("$.discountCents").value(0))
                .andExpect(jsonPath("$.cancellation.allowed").value(true))
                .andExpect(jsonPath("$.items", hasSize(2)))
                .andExpect(jsonPath("$.items[0].sectorName").value("Pista"))
                .andExpect(jsonPath("$.items[0].unitPriceCents").value(18_000))
                .andExpect(jsonPath("$.tickets[*].status", contains("VALID", "VALID")));

        assertThat(inventory.reservationStatus(reservation)).isEqualTo("CONFIRMED");
        assertThat(inventory.sector(show).get("available").asInt()).isEqualTo(8);
        // Outra pessoa não lê o pedido.
        this.mvc.perform(get(location).header("Authorization", token("bia")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:not-found"));
    }

    @Test
    void cancelamentoPeloCompradorEstornaEDevolveOsIngressosAVenda() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(6, 18_000));
        UUID reservation = inventory.reserve("caio", show, 2);
        String location = order("caio", reservation).andExpect(status().isCreated())
                .andReturn().getResponse().getHeader("Location");
        awaitStatus("caio", location, "CONFIRMED");
        assertThat(inventory.sector(show).get("available").asInt()).isEqualTo(4);

        this.mvc.perform(post(location + "/cancel").header("Authorization", token("caio")))
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.status").value("REFUNDING"))
                .andExpect(jsonPath("$.tickets[*].status", contains("CANCELLED", "CANCELLED")));

        // O payment-mock estorna e o inventory devolve os ingressos à venda.
        awaitStatus("caio", location, "REFUNDED");
        this.mvc.perform(get(location).header("Authorization", token("caio")))
                .andExpect(jsonPath("$.refundedCents").value(39_600));
        await().atMost(Duration.ofSeconds(30)).untilAsserted(() -> {
            assertThat(inventory.reservationStatus(reservation)).isEqualTo("RETURNED");
            assertThat(inventory.sector(show).get("available").asInt()).isEqualTo(6);
        });
    }

    @Test
    void compraDeCadeirasEmiteUmIngressoPorCadeira() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithSeats(2, 5, 30_000));
        UUID reservation = inventory.reserveSeats("ana", show, "B-2", "B-1");

        String location = order("ana", reservation).andExpect(status().isCreated())
                .andExpect(jsonPath("$.totalCents").value(66_000))
                .andReturn().getResponse().getHeader("Location");
        awaitStatus("ana", location, "CONFIRMED");
        this.mvc.perform(get(location).header("Authorization", token("ana")))
                .andExpect(jsonPath("$.items[*].seat", contains("B-1", "B-2")))
                .andExpect(jsonPath("$.tickets[*].seat", contains("B-1", "B-2")))
                .andExpect(jsonPath("$.tickets[*].sectorName", contains("Cadeira", "Cadeira")));

        // As cadeiras vendidas não voltam à venda.
        assertThat(inventory.reserve("bia", show, "\"seats\": [\"B-1\"]", Cpfs.next()).status()).isEqualTo(409);
    }

    @Test
    void pagamentoRecusadoCancelaOPedidoEDevolveOsIngressosAVenda() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(4, 18_000));
        String cpf = Cpfs.next();
        var held = inventory.reserve("recusada", show, "\"quantity\": 4", cpf);
        UUID reservation = UUID.fromString(held.body().get("id").asString());
        assertThat(inventory.sector(show).get("sale").asString()).isEqualTo("SOLD_OUT");
        payments.declineWhen("recusada"::equals);

        String location = order("recusada", reservation).andExpect(status().isCreated())
                .andReturn().getResponse().getHeader("Location");

        awaitStatus("recusada", location, "CANCELLED");
        this.mvc.perform(get(location).header("Authorization", token("recusada")))
                .andExpect(jsonPath("$.cancelReason").value("PAYMENT_DECLINED"))
                .andExpect(jsonPath("$.tickets", hasSize(0)));
        // Compensação: a reserva foi liberada, o estoque e a cota do CPF voltaram.
        assertThat(inventory.reservationStatus(reservation)).isEqualTo("RELEASED");
        await().atMost(Duration.ofSeconds(10))
                .until(() -> inventory.sector(show).get("available").asInt() == 4);
        assertThat(inventory.reserve("recusada", show, "\"quantity\": 4", cpf).status()).isEqualTo(201);
        assertThat(tickets(show)).isZero();
    }

    /** O critério da fase 3: com 30% dos pagamentos recusados, a saga compensa cada um. */
    @Test
    void comTrintaPorCentoDeRecusaCadaPedidoTerminaPagoOuCompensado() {
        Neighbours.Show show = onSale(neighbours.showWithPista(40, 10_000));
        // Três em cada dez compradores têm o pagamento recusado.
        payments.declineWhen(buyer -> Integer.parseInt(buyer.substring(buyer.lastIndexOf('-') + 1)) % 10 < 3);

        List<Result<String>> results = Concurrently.run(20, i -> {
            String buyer = "lote-30-" + i;
            UUID reservation = inventory.reserve(buyer, show, 2);
            String location = order(buyer, reservation).andExpect(status().isCreated())
                    .andReturn().getResponse().getHeader("Location");
            return buyer + " " + location;
        });
        assertThat(results).allMatch(Result::succeeded);

        Map<String, String> finalStatus = results.stream().map(Result::value)
                .collect(Collectors.toMap(value -> value.split(" ")[0], value -> {
                    String[] parts = value.split(" ");
                    return awaitFinal(parts[0], parts[1]);
                }));
        long declined = finalStatus.keySet().stream()
                .filter(buyer -> Integer.parseInt(buyer.substring(buyer.lastIndexOf('-') + 1)) % 10 < 3).count();
        assertThat(declined).isEqualTo(6);
        assertThat(finalStatus.values().stream().filter("CANCELLED"::equals)).hasSize(6);
        assertThat(finalStatus.values().stream().filter("CONFIRMED"::equals)).hasSize(14);

        // Só os pedidos pagos têm ingressos; os ingressos dos recusados voltaram à venda.
        assertThat(tickets(show)).isEqualTo(28);
        await().atMost(Duration.ofSeconds(15))
                .until(() -> inventory.sector(show).get("available").asInt() == 40 - 28);
    }

    @Test
    void repeticaoComAMesmaChaveDevolveOMesmoPedidoSemCobrarDeNovo() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(10, 18_000));
        UUID reservation = inventory.reserve("ana", show, 1);
        String key = UUID.randomUUID().toString();

        String location = order("ana", reservation, key).andExpect(status().isCreated())
                .andExpect(header().doesNotExist("Idempotent-Replayed"))
                .andReturn().getResponse().getHeader("Location");
        awaitStatus("ana", location, "CONFIRMED");
        String confirmed = this.mvc.perform(get(location).header("Authorization", token("ana")))
                .andReturn().getResponse().getContentAsString();

        order("ana", reservation, key)
                .andExpect(status().isCreated())
                .andExpect(header().string("Idempotent-Replayed", "true"))
                .andExpect(content().json(confirmed));
        // Outra chave para a mesma reserva também devolve o pedido que já existe.
        order("ana", reservation)
                .andExpect(header().string("Idempotent-Replayed", "true"))
                .andExpect(content().json(confirmed));

        assertThat(tickets(show)).isEqualTo(1);
        assertThat(payments.authorizationsOf(idOf(location))).isEqualTo(1);
        // A mesma chave com outra reserva é erro do cliente.
        order("ana", inventory.reserve("ana", show, 1), key)
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:idempotency-key-reused"));
    }

    @Test
    void vinteCliquesSimultaneosCriamUmPedidoSo() {
        Neighbours.Show show = onSale(neighbours.showWithPista(10, 18_000));
        UUID reservation = inventory.reserve("clique", show, 3);

        List<Result<String>> results = Concurrently.run(20, i -> order("clique", reservation)
                .andExpect(status().isCreated())
                .andReturn().getResponse().getHeader("Location"));

        assertThat(results).allMatch(Result::succeeded);
        assertThat(results.stream().map(Result::value).distinct()).hasSize(1);
        String location = results.getFirst().value();
        awaitStatus("clique", location, "CONFIRMED");
        assertThat(tickets(show)).isEqualTo(3);
        assertThat(payments.authorizationsOf(idOf(location))).isEqualTo(1);
    }

    @Test
    void naoFechaACompraDeReservaAlheiaInexistenteOuQueNaoEstaMaisAtiva() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(10, 18_000));
        UUID fromAna = inventory.reserve("ana", show, 1);
        UUID released = inventory.reserve("ana", show, 1);
        inventory.release(released);

        order("bia", fromAna)
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:not-found"));
        order("ana", UUID.randomUUID()).andExpect(status().isNotFound());
        order("ana", released)
                .andExpect(status().isConflict())
                .andExpect(content().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON))
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:reservation-not-held"));

        assertThat(tickets(show)).isZero();
        assertThat(inventory.reservationStatus(fromAna)).isEqualTo("HELD");
    }

    @Test
    void quarentaCompradoresDisputamQuinzeIngressosEExatamenteQuinzeSaoEmitidos() {
        Neighbours.Show show = onSale(neighbours.showWithPista(15, 12_000));

        // Cada comprador reserva e fecha a compra, todos ao mesmo tempo.
        List<Result<String>> results = Concurrently.run(40, i -> {
            String buyer = "disputa-" + i;
            var held = inventory.reserve(buyer, show, "\"quantity\": 1", Cpfs.next());
            if (held.status() != 201) {
                return held.body().get("type").asString();
            }
            String location = order(buyer, UUID.fromString(held.body().get("id").asString()))
                    .andExpect(status().isCreated()).andReturn().getResponse().getHeader("Location");
            return awaitFinal(buyer, location);
        });

        assertThat(results).allMatch(Result::succeeded);
        assertThat(results.stream().map(Result::value).filter("CONFIRMED"::equals)).hasSize(15);
        assertThat(results.stream().map(Result::value).filter(v -> !v.equals("CONFIRMED")))
                .hasSize(25).containsOnly("urn:lotou:problem:sold-out");
        assertThat(tickets(show)).isEqualTo(15);
        assertThat(inventory.sector(show).get("sale").asString()).isEqualTo("SOLD_OUT");
    }

    @Test
    void listaOsPedidosDoCompradorDoMaisNovoAoMaisAntigoPorCursor() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(20, 10_000));
        String buyer = "colecionadora-" + UUID.randomUUID();
        List<String> created = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            String location = order(buyer, inventory.reserve(buyer, show, 1)).andExpect(status().isCreated())
                    .andReturn().getResponse().getHeader("Location");
            awaitStatus(buyer, location, "CONFIRMED");
            created.add(location.substring("/v1/orders/".length()));
        }

        String page = this.mvc.perform(get("/v1/orders?limit=2").header("Authorization", token(buyer)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[*].id", contains(created.get(2), created.get(1))))
                .andExpect(jsonPath("$.items[0].status").value("CONFIRMED"))
                .andExpect(jsonPath("$.items[0].tickets").value(1))
                .andExpect(jsonPath("$.items[0].totalCents").value(11_000))
                .andReturn().getResponse().getContentAsString();
        String cursor = JsonPath.read(page, "$.nextCursor");

        this.mvc.perform(get("/v1/orders?limit=2&cursor=" + cursor).header("Authorization", token(buyer)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[*].id", contains(created.get(0))))
                .andExpect(jsonPath("$.nextCursor").value(nullValue()));
        this.mvc.perform(get("/v1/orders?cursor=adulterado").header("Authorization", token(buyer)))
                .andExpect(status().isBadRequest());
    }

    @Test
    void exigeTokenPapelDeCompradorCorpoValidoEIdempotencyKey() throws Exception {
        String body = "{\"reservationId\": \"%s\"}".formatted(UUID.randomUUID());

        this.mvc.perform(post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content(body)
                .header("Idempotency-Key", "chave"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().string("WWW-Authenticate", "Bearer"))
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:unauthorized"));
        this.mvc.perform(post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content(body)
                .header("Idempotency-Key", "chave")
                .header("Authorization", "Bearer " + neighbours.token("caio", "producer")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:forbidden"));
        // Um token assinado por outra chave não passa.
        this.mvc.perform(post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content(body)
                .header("Idempotency-Key", "chave")
                .header("Authorization", "Bearer " + Neighbours.start().token("ana", "buyer")))
                .andExpect(status().isUnauthorized());

        this.mvc.perform(post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content("{}")
                .header("Idempotency-Key", "chave").header("Authorization", token("ana")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("reservationId"));
        this.mvc.perform(post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content(body)
                .header("Authorization", token("ana")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("Idempotency-Key"));
    }

    // ------------------------------------------------------------------ apoio

    /**
     * Publica o show no catálogo e espera o inventory lê-lo e abrir as vendas, e o order-service
     * guardar a cópia dele (quem paga a taxa).
     */
    private Neighbours.Show onSale(Neighbours.Show show) {
        await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(100)).untilAsserted(() -> {
            var sector = inventory.sector(show);
            assertThat(sector).isNotNull();
            assertThat(sector.get("sale").asString()).isEqualTo("ON_SALE");
            assertThat(this.jdbc.sql("SELECT count(*) FROM shows WHERE id = :id").param("id", show.id())
                    .query(Integer.class).single()).isEqualTo(1);
        });
        return show;
    }

    private ResultActions order(String buyer, UUID reservationId, String idempotencyKey) throws Exception {
        return this.mvc.perform(post("/v1/orders")
                .header("Authorization", token(buyer))
                .header("Idempotency-Key", idempotencyKey)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"reservationId\": \"%s\"}".formatted(reservationId)));
    }

    private ResultActions order(String buyer, UUID reservationId) throws Exception {
        return order(buyer, reservationId, UUID.randomUUID().toString());
    }

    /** Espera a saga levar o pedido ao estado esperado, lendo pelo GET como o cliente faria. */
    private void awaitStatus(String buyer, String location, String expected) {
        assertThat(awaitFinal(buyer, location)).isEqualTo(expected);
    }

    /** Espera o pedido sair de PENDING e devolve o estado final. */
    private String awaitFinal(String buyer, String location) {
        return await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(100)).until(() -> {
            String body = this.mvc.perform(get(location).header("Authorization", token(buyer)))
                    .andReturn().getResponse().getContentAsString();
            return JsonPath.<String>read(body, "$.status");
        }, status -> !"PENDING".equals(status));
    }

    private static String token(String buyer) {
        return "Bearer " + neighbours.token(buyer, "buyer");
    }

    private static UUID idOf(String location) {
        return UUID.fromString(location.substring("/v1/orders/".length()));
    }

    private int tickets(Neighbours.Show show) {
        return this.jdbc.sql("SELECT count(*) FROM tickets WHERE show_id = :id").param("id", show.id())
                .query(Integer.class).single();
    }
}

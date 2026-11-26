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
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.support.Concurrently;
import br.com.lotou.order.support.Concurrently.Result;
import br.com.lotou.order.support.ControllablePaymentGateway;
import br.com.lotou.order.support.Cpfs;
import br.com.lotou.order.support.EndToEndEnvironment;
import br.com.lotou.order.support.InventoryApi;
import br.com.lotou.order.support.Neighbours;
import br.com.lotou.order.support.TestBeans;
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
 * O checkout de ponta a ponta: o order-service de verdade conversando com o inventory-service de
 * verdade (a imagem Docker dele), os dois num Postgres real. Só o emissor de tokens, o catálogo de
 * shows e o pagamento são de teste, e os tokens são validados de verdade pelos dois serviços.
 */
@SpringBootTest
@AutoConfigureMockMvc
@Import(TestBeans.class)
class CheckoutEndToEndTests {

    private static final Neighbours neighbours = EndToEndEnvironment.NEIGHBOURS;
    private static final InventoryApi inventory = new InventoryApi(EndToEndEnvironment.inventoryUrl(), neighbours);

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ControllablePaymentGateway payments;

    @Autowired
    private JdbcClient jdbc;

    @DynamicPropertySource
    static void environment(DynamicPropertyRegistry registry) {
        EndToEndEnvironment.configure(registry);
        registry.add("INVENTORY_SERVICE_URL", EndToEndEnvironment::inventoryUrl);
    }

    @BeforeEach
    void resetPayments() {
        this.payments.reset();
    }

    /** Publica o show no catálogo e espera o inventory lê-lo e abrir as vendas. */
    private static Neighbours.Show onSale(Neighbours.Show show) {
        await().atMost(Duration.ofSeconds(20)).pollInterval(Duration.ofMillis(100)).untilAsserted(() -> {
            var sector = inventory.sector(show);
            assertThat(sector).isNotNull();
            assertThat(sector.get("sale").asString()).isEqualTo("ON_SALE");
        });
        return show;
    }

    private ResultActions order(String buyer, UUID reservationId, String idempotencyKey) throws Exception {
        return this.mvc.perform(post("/v1/orders")
                .header("Authorization", "Bearer " + neighbours.token(buyer, "buyer"))
                .header("Idempotency-Key", idempotencyKey)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"reservationId\": \"%s\"}".formatted(reservationId)));
    }

    private ResultActions order(String buyer, UUID reservationId) throws Exception {
        return order(buyer, reservationId, UUID.randomUUID().toString());
    }

    private int tickets(Neighbours.Show show) {
        return this.jdbc.sql("SELECT count(*) FROM tickets WHERE show_id = :id").param("id", show.id())
                .query(Integer.class).single();
    }

    @Test
    void compraNaPistaConfirmaOPedidoEmiteOsIngressosEVendeAReserva() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(10, 18_000));
        UUID reservation = inventory.reserve("ana", show, 2);

        String location = order("ana", reservation)
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", matchesPattern("/v1/orders/[0-9a-f-]{36}")))
                .andExpect(jsonPath("$.id", matchesPattern("[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f-]+")))
                .andExpect(jsonPath("$.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.showId").value(show.id().toString()))
                .andExpect(jsonPath("$.reservationId").value(reservation.toString()))
                .andExpect(jsonPath("$.totalCents").value(36_000))
                .andExpect(jsonPath("$.cancelReason").value(nullValue()))
                .andExpect(jsonPath("$.confirmedAt").isNotEmpty())
                .andExpect(jsonPath("$.items", hasSize(2)))
                .andExpect(jsonPath("$.items[0].sectorName").value("Pista"))
                .andExpect(jsonPath("$.items[0].lotName").value("Lote único"))
                .andExpect(jsonPath("$.items[0].unitPriceCents").value(18_000))
                .andExpect(jsonPath("$.tickets", hasSize(2)))
                .andExpect(jsonPath("$.tickets[*].status", contains("VALID", "VALID")))
                .andReturn().getResponse().getHeader("Location");

        assertThat(inventory.reservationStatus(reservation)).isEqualTo("CONFIRMED");
        assertThat(inventory.sector(show).get("available").asInt()).isEqualTo(8);

        // O dono lê o pedido; outra pessoa, não.
        String ana = "Bearer " + neighbours.token("ana", "buyer");
        this.mvc.perform(get(location).header("Authorization", ana))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.tickets", hasSize(2)));
        this.mvc.perform(get(location).header("Authorization", "Bearer " + neighbours.token("bia", "buyer")))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:not-found"));
    }

    @Test
    void compraDeCadeirasEmiteUmIngressoPorCadeira() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithSeats(2, 5, 30_000));
        UUID reservation = inventory.reserveSeats("ana", show, "B-2", "B-1");

        order("ana", reservation)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.totalCents").value(60_000))
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
        var held = inventory.reserve("ana", show, "\"quantity\": 4", cpf);
        UUID reservation = UUID.fromString(held.body().get("id").asString());
        assertThat(inventory.sector(show).get("sale").asString()).isEqualTo("SOLD_OUT");
        this.payments.declineNext();

        order("ana", reservation)
                .andExpect(status().isCreated())
                .andExpect(jsonPath("$.status").value("CANCELLED"))
                .andExpect(jsonPath("$.cancelReason").value("PAYMENT_DECLINED"))
                .andExpect(jsonPath("$.tickets", hasSize(0)));

        // Compensação: a reserva foi liberada, o estoque e a cota do CPF voltaram.
        assertThat(inventory.reservationStatus(reservation)).isEqualTo("RELEASED");
        assertThat(inventory.sector(show).get("available").asInt()).isEqualTo(4);
        assertThat(inventory.reserve("ana", show, "\"quantity\": 4", cpf).status()).isEqualTo(201);
        assertThat(tickets(show)).isZero();
    }

    @Test
    void repeticaoComAMesmaChaveDevolveOMesmoPedidoSemCobrarDeNovo() throws Exception {
        Neighbours.Show show = onSale(neighbours.showWithPista(10, 18_000));
        UUID reservation = inventory.reserve("ana", show, 1);
        String key = UUID.randomUUID().toString();

        String first = order("ana", reservation, key).andExpect(status().isCreated())
                .andExpect(header().doesNotExist("Idempotent-Replayed"))
                .andReturn().getResponse().getContentAsString();
        order("ana", reservation, key)
                .andExpect(status().isCreated())
                .andExpect(header().string("Idempotent-Replayed", "true"))
                .andExpect(content().json(first));
        // Outra chave para a mesma reserva também devolve o pedido que já existe.
        order("ana", reservation)
                .andExpect(status().isCreated())
                .andExpect(header().string("Idempotent-Replayed", "true"))
                .andExpect(content().json(first));

        assertThat(tickets(show)).isEqualTo(1);
        // A mesma chave com outra reserva é erro do cliente.
        order("ana", inventory.reserve("ana", show, 1), key)
                .andExpect(status().isUnprocessableContent())
                .andExpect(jsonPath("$.type").value("urn:lotou:problem:idempotency-key-reused"));
    }

    @Test
    void vinteCliquesSimultaneosCriamUmPedidoSo() {
        Neighbours.Show show = onSale(neighbours.showWithPista(10, 18_000));
        UUID reservation = inventory.reserve("ana", show, 3);

        List<Result<String>> results = Concurrently.run(20, i -> order("ana", reservation)
                .andExpect(status().isCreated())
                .andReturn().getResponse().getHeader("Location"));

        assertThat(results).allMatch(Result::succeeded);
        assertThat(results.stream().map(Result::value).distinct()).hasSize(1);
        assertThat(tickets(show)).isEqualTo(3);
        assertThat(this.payments.authorizationsOf(UUID.fromString(results.getFirst().value()
                .substring("/v1/orders/".length())))).isEqualTo(1);
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
            String buyer = "comprador-" + i;
            var held = inventory.reserve(buyer, show, "\"quantity\": 1", Cpfs.next());
            if (held.status() != 201) {
                return held.body().get("type").asString();
            }
            return order(buyer, UUID.fromString(held.body().get("id").asString()))
                    .andExpect(status().isCreated())
                    .andExpect(jsonPath("$.status").value("CONFIRMED"))
                    .andReturn().getResponse().getHeader("Location").startsWith("/v1/orders/") ? "CONFIRMED" : "?";
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
        String token = "Bearer " + neighbours.token(buyer, "buyer");
        List<String> created = new java.util.ArrayList<>();
        for (int i = 0; i < 3; i++) {
            created.add(order(buyer, inventory.reserve(buyer, show, 1)).andExpect(status().isCreated())
                    .andReturn().getResponse().getHeader("Location").substring("/v1/orders/".length()));
        }

        String page = this.mvc.perform(get("/v1/orders?limit=2").header("Authorization", token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[*].id", contains(created.get(2), created.get(1))))
                .andExpect(jsonPath("$.items[0].status").value("CONFIRMED"))
                .andExpect(jsonPath("$.items[0].tickets").value(1))
                .andExpect(jsonPath("$.items[0].totalCents").value(10_000))
                .andReturn().getResponse().getContentAsString();
        String cursor = com.jayway.jsonpath.JsonPath.read(page, "$.nextCursor");

        this.mvc.perform(get("/v1/orders?limit=2&cursor=" + cursor).header("Authorization", token))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items[*].id", contains(created.get(0))))
                .andExpect(jsonPath("$.nextCursor").value(nullValue()));
        this.mvc.perform(get("/v1/orders?cursor=adulterado").header("Authorization", token))
                .andExpect(status().isBadRequest());
    }

    @Test
    void exigeTokenPapelDeCompradorCorpoValidoEIdempotencyKey() throws Exception {
        String body = "{\"reservationId\": \"%s\"}".formatted(UUID.randomUUID());
        var request = post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content(body)
                .header("Idempotency-Key", "chave");

        this.mvc.perform(request)
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

        String ana = "Bearer " + neighbours.token("ana", "buyer");
        this.mvc.perform(post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content("{}")
                .header("Idempotency-Key", "chave").header("Authorization", ana))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("reservationId"));
        this.mvc.perform(post("/v1/orders").contentType(MediaType.APPLICATION_JSON).content(body)
                .header("Authorization", ana))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[0].field").value("Idempotency-Key"));
    }
}

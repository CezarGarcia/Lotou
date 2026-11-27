package br.com.lotou.gateway;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.reactive.server.SecurityMockServerConfigurers.mockJwt;
import static org.springframework.security.test.web.reactive.server.SecurityMockServerConfigurers.springSecurity;

import java.util.Map;

import br.com.lotou.gateway.support.UpstreamStub;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.test.web.reactive.server.SecurityMockServerConfigurers.JwtMutator;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * Rotas e regras de acesso do gateway, com o event-service trocado por um servidor de mentira. O
 * usuário é simulado: a validação real do token é coberta em {@link KeycloakIntegrationTests}.
 */
@SpringBootTest
class GatewayRoutingAndSecurityTests {

    private static final UpstreamStub eventService = UpstreamStub.start();
    private static final UpstreamStub inventoryService = UpstreamStub.start();
    private static final UpstreamStub orderService = UpstreamStub.start();
    private static final UpstreamStub analyticsService = UpstreamStub.start();
    private static final UpstreamStub checkinService = UpstreamStub.start();
    private static final UpstreamStub notificationService = UpstreamStub.start();

    @Autowired
    private ApplicationContext context;

    private WebTestClient client;

    @DynamicPropertySource
    static void routes(DynamicPropertyRegistry registry) {
        registry.add("EVENT_SERVICE_URL", eventService::url);
        registry.add("INVENTORY_SERVICE_URL", inventoryService::url);
        registry.add("ORDER_SERVICE_URL", orderService::url);
        registry.add("ANALYTICS_SERVICE_URL", analyticsService::url);
        registry.add("CHECKIN_SERVICE_URL", checkinService::url);
        registry.add("NOTIFICATION_SERVICE_URL", notificationService::url);
    }

    @AfterAll
    static void stopStub() {
        eventService.close();
        inventoryService.close();
        orderService.close();
        analyticsService.close();
        checkinService.close();
        notificationService.close();
    }

    @BeforeEach
    void setUp() {
        eventService.reset();
        inventoryService.reset();
        orderService.reset();
        analyticsService.reset();
        checkinService.reset();
        notificationService.reset();
        this.client = WebTestClient.bindToApplicationContext(this.context)
                .apply(springSecurity())
                .configureClient()
                .build();
    }

    private static JwtMutator userWithRole(String role) {
        return mockJwt().authorities(new SimpleGrantedAuthority("ROLE_" + role));
    }

    @Test
    void buscaDeShowsEhPublicaERoteadaSemOPrefixoApi() {
        eventService.respondWith(200, Map.of(), "{\"items\":[],\"nextCursor\":null}");

        this.client.get().uri("/api/v1/shows?city=Belém&limit=5")
                .exchange()
                .expectStatus().isOk()
                .expectBody().jsonPath("$.nextCursor").isEmpty();

        var received = eventService.lastRequest();
        assertThat(received.method()).isEqualTo("GET");
        assertThat(received.path()).isEqualTo("/v1/shows");
        assertThat(received.query()).isEqualTo("city=Belém&limit=5");
    }

    @Test
    void paginaDoShowELocaisTambemSaoPublicos() {
        this.client.get().uri("/api/v1/shows/0198c2f4-7f8e-7abc-8def-0123456789ab").exchange()
                .expectStatus().isOk();
        this.client.get().uri("/api/v1/venues").exchange().expectStatus().isOk();

        assertThat(eventService.requests()).extracting(UpstreamStub.ReceivedRequest::path)
                .containsExactly("/v1/shows/0198c2f4-7f8e-7abc-8def-0123456789ab", "/v1/venues");
    }

    @Test
    void escritaSemTokenResponde401EmProblemDetailsSemChegarAoServico() {
        this.client.post().uri("/api/v1/shows")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectHeader().valueEquals("WWW-Authenticate", "Bearer")
                .expectBody()
                .jsonPath("$.type").isEqualTo("urn:lotou:problem:unauthorized")
                .jsonPath("$.title").isEqualTo("Não autenticado")
                .jsonPath("$.status").isEqualTo(401)
                .jsonPath("$.instance").isEqualTo("/api/v1/shows");

        assertThat(eventService.requests()).isEmpty();
    }

    @Test
    void escritaComPapelDeCompradorResponde403SemChegarAoServico() {
        for (String role : new String[] {"buyer", "gate-staff"}) {
            this.client.mutateWith(userWithRole(role))
                    .patch().uri("/api/v1/venues/0198c2f4-7f8e-7abc-8def-0123456789ab")
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue("{}")
                    .exchange()
                    .expectStatus().isForbidden()
                    .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                    .expectBody().jsonPath("$.type").isEqualTo("urn:lotou:problem:forbidden");
        }
        assertThat(eventService.requests()).isEmpty();
    }

    @Test
    void escritaDoProdutorEhRoteadaEOLocationGanhaOPrefixoApi() {
        eventService.respondWith(201, Map.of("Location", "/v1/shows/abc"), "{\"id\":\"abc\"}");

        this.client.mutateWith(userWithRole("producer"))
                .post().uri("/api/v1/shows")
                .header("Idempotency-Key", "chave-1")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{\"title\":\"Show\"}")
                .exchange()
                .expectStatus().isCreated()
                .expectHeader().valueEquals("Location", "/api/v1/shows/abc")
                .expectBody().jsonPath("$.id").isEqualTo("abc");

        var received = eventService.lastRequest();
        assertThat(received.path()).isEqualTo("/v1/shows");
        assertThat(received.header("Idempotency-Key")).isEqualTo("chave-1");
    }

    @Test
    void disponibilidadeEhPublicaEVaiParaOInventory() {
        this.client.get().uri("/api/v1/availability/0198c2f4-7f8e-7abc-8def-0123456789ab/sectors/x/seats")
                .exchange()
                .expectStatus().isOk();

        assertThat(inventoryService.lastRequest().path())
                .isEqualTo("/v1/availability/0198c2f4-7f8e-7abc-8def-0123456789ab/sectors/x/seats");
        assertThat(eventService.requests()).isEmpty();
    }

    @Test
    void reservarEComprarExigemOPapelDeComprador() {
        for (String path : new String[] {"/api/v1/reservations", "/api/v1/orders"}) {
            this.client.post().uri(path).contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                    .exchange()
                    .expectStatus().isUnauthorized();
            this.client.mutateWith(userWithRole("producer"))
                    .post().uri(path).contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                    .exchange()
                    .expectStatus().isForbidden();
        }
        this.client.get().uri("/api/v1/orders").exchange().expectStatus().isUnauthorized();

        assertThat(inventoryService.requests()).isEmpty();
        assertThat(orderService.requests()).isEmpty();
    }

    @Test
    void reservaDoCompradorVaiParaOInventoryEOPedidoParaOOrder() {
        inventoryService.respondWith(201, Map.of("Location", "/v1/reservations/r1"), "{\"id\":\"r1\"}");
        orderService.respondWith(201, Map.of("Location", "/v1/orders/o1"), "{\"id\":\"o1\"}");

        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/reservations")
                .header("Idempotency-Key", "chave-r")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isCreated()
                .expectHeader().valueEquals("Location", "/api/v1/reservations/r1");
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/orders")
                .header("Idempotency-Key", "chave-o")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isCreated()
                .expectHeader().valueEquals("Location", "/api/v1/orders/o1");
        orderService.respondWith(200, Map.of(), "{\"items\":[]}");
        this.client.mutateWith(userWithRole("buyer")).get().uri("/api/v1/orders?limit=5").exchange()
                .expectStatus().isOk();

        assertThat(inventoryService.lastRequest().path()).isEqualTo("/v1/reservations");
        assertThat(inventoryService.lastRequest().header("Idempotency-Key")).isEqualTo("chave-r");
        assertThat(orderService.requests()).extracting(UpstreamStub.ReceivedRequest::path)
                .containsExactly("/v1/orders", "/v1/orders");
    }

    @Test
    void vendasDoShowSaoDoProdutorEVaoParaOAnalytics() {
        this.client.get().uri("/api/v1/analytics/shows/s1/sales").exchange()
                .expectStatus().isUnauthorized();
        this.client.mutateWith(userWithRole("buyer"))
                .get().uri("/api/v1/analytics/shows/s1/sales").exchange()
                .expectStatus().isForbidden();
        this.client.mutateWith(userWithRole("producer"))
                .get().uri("/api/v1/analytics/shows/s1/statement").exchange()
                .expectStatus().isOk();

        assertThat(analyticsService.lastRequest().path()).isEqualTo("/v1/analytics/shows/s1/statement");
        assertThat(inventoryService.requests()).isEmpty();
    }

    @Test
    void compradorCotaECancelaOPedidoMasNaoMexeEmCuponsNemEmEstornos() {
        orderService.respondWith(200, Map.of(), "{}");
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/orders/quote").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isOk();
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/orders/o1/cancel").exchange().expectStatus().isOk();
        assertThat(orderService.requests()).extracting(UpstreamStub.ReceivedRequest::path)
                .containsExactly("/v1/orders/quote", "/v1/orders/o1/cancel");

        orderService.reset();
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/coupons").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isForbidden();
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/orders/o1/refund/retry").exchange().expectStatus().isForbidden();
        this.client.mutateWith(userWithRole("buyer"))
                .get().uri("/api/v1/orders/refund-failed?showId=s1").exchange().expectStatus().isForbidden();
        // E o produtor não compra nem cancela pedido de comprador.
        this.client.mutateWith(userWithRole("producer"))
                .post().uri("/api/v1/orders/o1/cancel").exchange().expectStatus().isForbidden();
        assertThat(orderService.requests()).isEmpty();
    }

    @Test
    void cuponsEEstornosQueFalharamSaoDoProdutorEVaoParaOOrder() {
        orderService.respondWith(201, Map.of("Location", "/v1/coupons/c1"), "{\"id\":\"c1\"}");
        this.client.mutateWith(userWithRole("producer"))
                .post().uri("/api/v1/coupons").header("Idempotency-Key", "chave-c")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange()
                .expectStatus().isCreated()
                .expectHeader().valueEquals("Location", "/api/v1/coupons/c1");
        orderService.respondWith(200, Map.of(), "[]");
        this.client.mutateWith(userWithRole("producer"))
                .get().uri("/api/v1/orders/refund-failed?showId=s1").exchange().expectStatus().isOk();
        this.client.mutateWith(userWithRole("producer"))
                .post().uri("/api/v1/orders/o1/refund/retry").exchange().expectStatus().isOk();

        assertThat(orderService.requests()).extracting(UpstreamStub.ReceivedRequest::path)
                .containsExactly("/v1/coupons", "/v1/orders/refund-failed", "/v1/orders/o1/refund/retry");
        assertThat(orderService.requests().getFirst().header("Idempotency-Key")).isEqualTo("chave-c");
    }

    @Test
    void portariaEDaEquipeDoPortaoEDoProdutorEVaiParaOCheckin() {
        this.client.post().uri("/api/v1/checkins").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isUnauthorized();
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/checkins").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isForbidden();
        assertThat(checkinService.requests()).isEmpty();

        checkinService.respondWith(200, Map.of(), "{\"result\":\"ACCEPTED\"}");
        this.client.mutateWith(userWithRole("gate-staff"))
                .post().uri("/api/v1/checkins").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isOk();
        this.client.mutateWith(userWithRole("producer"))
                .get().uri("/api/v1/checkins/shows/s1/summary").exchange().expectStatus().isOk();
        assertThat(checkinService.requests()).extracting(UpstreamStub.ReceivedRequest::path)
                .containsExactly("/v1/checkins", "/v1/checkins/shows/s1/summary");
    }

    @Test
    void relatorioFinanceiroEDoProdutorEVaiParaONotification() {
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/reports/statements").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isForbidden();
        this.client.mutateWith(userWithRole("gate-staff"))
                .post().uri("/api/v1/reports/statements").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isForbidden();
        notificationService.respondWith(202, Map.of(), "{}");
        this.client.mutateWith(userWithRole("producer"))
                .post().uri("/api/v1/reports/statements").contentType(MediaType.APPLICATION_JSON).bodyValue("{}")
                .exchange().expectStatus().isAccepted();
        assertThat(notificationService.lastRequest().path()).isEqualTo("/v1/reports/statements");
    }

    @Test
    void pausarLoteExigeOPapelDeProdutor() {
        this.client.mutateWith(userWithRole("buyer"))
                .post().uri("/api/v1/lots/l1/pause").exchange()
                .expectStatus().isForbidden();
        this.client.mutateWith(userWithRole("producer"))
                .post().uri("/api/v1/lots/l1/pause").exchange()
                .expectStatus().isOk();

        assertThat(inventoryService.lastRequest().path()).isEqualTo("/v1/lots/l1/pause");
    }

    @Test
    void apiInternaDosServicosNaoTemRotaNoGateway() {
        for (String path : new String[] {"/api/internal/v1/reservations/r1", "/internal/v1/reservations/r1",
                "/api/internal/v1/catalog/shows"}) {
            this.client.mutateWith(userWithRole("service")).get().uri(path).exchange()
                    .expectStatus().isNotFound();
        }
        assertThat(inventoryService.requests()).isEmpty();
        assertThat(eventService.requests()).isEmpty();
    }

    @Test
    void filaVirtualExigeCompradorEVaiParaOInventory() {
        this.client.post().uri("/api/v1/queue/s1").exchange().expectStatus().isUnauthorized();
        this.client.mutateWith(userWithRole("producer")).get().uri("/api/v1/queue/s1").exchange()
                .expectStatus().isForbidden();

        this.client.mutateWith(userWithRole("buyer")).post().uri("/api/v1/queue/s1").exchange()
                .expectStatus().isOk();
        this.client.mutateWith(userWithRole("buyer")).get().uri("/api/v1/queue/s1").exchange()
                .expectStatus().isOk();

        assertThat(inventoryService.requests()).extracting(UpstreamStub.ReceivedRequest::path)
                .containsExactly("/v1/queue/s1", "/v1/queue/s1");
    }

    @Test
    void fluxosSseVaoParaOInventory() {
        this.client.get().uri("/api/v1/availability/s1/sectors/a/seats/events").exchange().expectStatus().isOk();
        this.client.mutateWith(userWithRole("buyer")).get().uri("/api/v1/queue/s1/events").exchange()
                .expectStatus().isOk();

        assertThat(inventoryService.requests()).extracting(UpstreamStub.ReceivedRequest::path)
                .containsExactly("/v1/availability/s1/sectors/a/seats/events", "/v1/queue/s1/events");
    }

    @Test
    void erroDoServicoPassaSemAlteracao() {
        String problem = "{\"type\":\"urn:lotou:problem:not-found\",\"title\":\"Recurso não encontrado\",\"status\":404}";
        eventService.respondWith(404, Map.of("Content-Type", "application/problem+json"), problem);

        this.client.get().uri("/api/v1/shows/0198c2f4-7f8e-7abc-8def-0123456789ab")
                .exchange()
                .expectStatus().isNotFound()
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody().json(problem);
    }

    @Test
    void tokenMalformadoResponde401MesmoEmRotaPublica() {
        this.client.get().uri("/api/v1/shows")
                .header("Authorization", "Bearer isto-nao-e-um-jwt")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON);

        assertThat(eventService.requests()).isEmpty();
    }

    @Test
    void rotaForaDoCatalogoEhFechadaPorPadrao() {
        this.client.get().uri("/api/v1/payments").exchange().expectStatus().isUnauthorized();
        this.client.get().uri("/qualquer-coisa").exchange().expectStatus().isUnauthorized();
    }

    @Test
    void rotaInexistenteResponde404EmProblemDetailsParaQuemEstaAutenticado() {
        this.client.mutateWith(userWithRole("buyer"))
                .get().uri("/api/v1/payments")
                .exchange()
                .expectStatus().isNotFound()
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody()
                .jsonPath("$.status").isEqualTo(404)
                .jsonPath("$.instance").isEqualTo("/api/v1/payments");
    }

    @Test
    void healthCheckEhPublico() {
        this.client.get().uri("/actuator/health/readiness")
                .exchange()
                .expectStatus().isOk()
                .expectBody().jsonPath("$.status").isEqualTo("UP");
    }

    @Test
    void outrosEndpointsDoActuatorNaoSaoExpostos() {
        this.client.mutateWith(userWithRole("producer"))
                .get().uri("/actuator/env")
                .exchange()
                .expectStatus().isNotFound();
    }
}

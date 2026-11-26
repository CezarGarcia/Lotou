package br.com.lotou.gateway;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.security.test.web.reactive.server.SecurityMockServerConfigurers.mockJwt;
import static org.springframework.security.test.web.reactive.server.SecurityMockServerConfigurers.springSecurity;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import br.com.lotou.gateway.support.UpstreamStub;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.ApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

/** Rate limit das operações de compra, com um Redis real (o mesmo token bucket da produção). */
@Testcontainers
@SpringBootTest(properties = {
        "RATE_LIMIT_RESERVE_PER_SECOND=1",
        "RATE_LIMIT_RESERVE_BURST=3" })
class RateLimitTests {

    @Container
    @ServiceConnection(name = "redis")
    static final GenericContainer<?> redis = new GenericContainer<>("redis:8.8-alpine").withExposedPorts(6379);

    private static final UpstreamStub inventory = UpstreamStub.start();

    @Autowired
    private ApplicationContext context;

    private WebTestClient client;

    @DynamicPropertySource
    static void routes(DynamicPropertyRegistry registry) {
        registry.add("INVENTORY_SERVICE_URL", inventory::url);
    }

    @AfterAll
    static void stopStub() {
        inventory.close();
    }

    @BeforeEach
    void setUp() {
        inventory.reset();
        inventory.respondWith(201, Map.of("Location", "/v1/reservations/r1"), "{\"id\":\"r1\"}");
        this.client = WebTestClient.bindToApplicationContext(this.context)
                .apply(springSecurity())
                .configureClient()
                .build();
    }

    private WebTestClient.ResponseSpec reserve(String subject) {
        return this.client.mutateWith(mockJwt().jwt(jwt -> jwt.subject(subject))
                        .authorities(new SimpleGrantedAuthority("ROLE_buyer")))
                .post().uri("/api/v1/reservations")
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{}")
                .exchange();
    }

    @Test
    void barraORajadaAcimaDoBaldeEmProblemDetailsSemChegarAoServico() {
        List<Integer> statuses = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            statuses.add(reserve("ana").returnResult(String.class).getStatus().value());
        }

        // Balde de 3: as três primeiras passam, as seguintes esperam o balde encher.
        assertThat(statuses.subList(0, 3)).containsOnly(201);
        assertThat(statuses.subList(3, 6)).contains(429);
        assertThat(inventory.requests()).hasSizeLessThan(6);

        reserve("ana")
                .expectStatus().isEqualTo(429)
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectHeader().valueEquals("Retry-After", "1")
                .expectHeader().exists("X-RateLimit-Remaining")
                .expectBody()
                .jsonPath("$.type").isEqualTo("urn:lotou:problem:rate-limited")
                .jsonPath("$.status").isEqualTo(429);
    }

    @Test
    void cadaUsuarioTemOSeuBalde() {
        for (int i = 0; i < 4; i++) {
            reserve("bia");
        }
        reserve("caio").expectStatus().isCreated();
    }

    @Test
    void consultarAReservaNaoGastaOBaldeDaCompra() {
        for (int i = 0; i < 5; i++) {
            this.client.mutateWith(mockJwt().jwt(jwt -> jwt.subject("duda"))
                            .authorities(new SimpleGrantedAuthority("ROLE_buyer")))
                    .get().uri("/api/v1/reservations/r1")
                    .exchange()
                    .expectStatus().is2xxSuccessful();
        }
        reserve("duda").expectStatus().isCreated();
    }
}

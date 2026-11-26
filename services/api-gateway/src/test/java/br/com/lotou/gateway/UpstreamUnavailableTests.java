package br.com.lotou.gateway;

import java.io.IOException;
import java.net.ServerSocket;

import org.junit.jupiter.api.Test;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.ApplicationContext;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

/** O que o cliente recebe quando o serviço de destino está fora do ar. */
@SpringBootTest
class UpstreamUnavailableTests {

    @Autowired
    private ApplicationContext context;

    @DynamicPropertySource
    static void routes(DynamicPropertyRegistry registry) throws IOException {
        // Uma porta que estava livre e foi fechada: ninguém escuta nela.
        int closedPort;
        try (var socket = new ServerSocket(0)) {
            closedPort = socket.getLocalPort();
        }
        registry.add("EVENT_SERVICE_URL", () -> "http://127.0.0.1:" + closedPort);
    }

    @Test
    void servicoForaDoArResponde503EmProblemDetails() {
        WebTestClient.bindToApplicationContext(this.context).build()
                .get().uri("/api/v1/shows")
                .exchange()
                .expectStatus().isEqualTo(503)
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody()
                .jsonPath("$.type").isEqualTo("urn:lotou:problem:upstream-unavailable")
                .jsonPath("$.title").isEqualTo("Serviço indisponível")
                .jsonPath("$.instance").isEqualTo("/api/v1/shows");
    }
}

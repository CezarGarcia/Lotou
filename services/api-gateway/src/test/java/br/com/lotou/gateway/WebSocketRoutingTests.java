package br.com.lotou.gateway;

import java.net.URI;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.netty.DisposableServer;
import reactor.netty.http.server.HttpServer;

import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.reactive.socket.WebSocketMessage;
import org.springframework.web.reactive.socket.client.ReactorNettyWebSocketClient;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * O WebSocket do painel atravessa o gateway até o analytics. Sem token na abertura: quem
 * autentica é o analytics, na primeira mensagem (ADR 17). O analytics aqui é um servidor de eco.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class WebSocketRoutingTests {

    /** Responde "eco: <mensagem>" e registra o caminho que recebeu. */
    private static final List<String> paths = new CopyOnWriteArrayList<>();

    private static final DisposableServer analytics = HttpServer.create()
            .host("127.0.0.1")
            .port(0)
            .route(routes -> routes.ws("/v1/analytics/live", (in, out) -> {
                paths.add("/v1/analytics/live");
                return out.sendString(in.receive().asString().map(text -> "eco: " + text));
            }))
            .bindNow();

    @LocalServerPort
    private int port;

    @DynamicPropertySource
    static void routes(DynamicPropertyRegistry registry) {
        registry.add("ANALYTICS_SERVICE_URL", () -> "http://127.0.0.1:" + analytics.port());
    }

    /** O navegador sempre manda o Origin da página no handshake, e a loja está em outro host:porta. */
    private static org.springframework.http.HttpHeaders browserOrigin() {
        var headers = new org.springframework.http.HttpHeaders();
        headers.setOrigin("http://localhost:4200");
        return headers;
    }

    @AfterAll
    static void stop() {
        analytics.disposeNow();
    }

    @Test
    void painelConectaSemTokenNaAberturaEAsMensagensVaoEVoltam() {
        List<String> received = new CopyOnWriteArrayList<>();
        new ReactorNettyWebSocketClient()
                .execute(URI.create("ws://localhost:" + this.port + "/api/v1/analytics/live"), browserOrigin(), session -> session
                        .send(Mono.just(session.textMessage("{\"type\":\"auth\",\"token\":\"t\"}")))
                        .thenMany(session.receive().map(WebSocketMessage::getPayloadAsText).take(1)
                                .doOnNext(received::add))
                        .then())
                .block(Duration.ofSeconds(10));

        assertThat(received).containsExactly("eco: {\"type\":\"auth\",\"token\":\"t\"}");
        assertThat(paths).containsExactly("/v1/analytics/live");
    }

    @Test
    void outroSiteNaoAbreOWebSocketDoPainel() {
        var headers = new org.springframework.http.HttpHeaders();
        headers.setOrigin("https://site-qualquer.example");
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> new ReactorNettyWebSocketClient()
                .execute(URI.create("ws://localhost:" + this.port + "/api/v1/analytics/live"), headers,
                        session -> session.close())
                .block(Duration.ofSeconds(10)))
                .hasMessageContaining("403");
    }
}

package br.com.lotou.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import br.com.lotou.gateway.support.UpstreamStub;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.MountableFile;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.MediaType;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * O gateway de verdade, numa porta real, validando tokens emitidos por um Keycloak real. O
 * Keycloak sobe num container com o mesmo arquivo de realm do Docker Compose, então o teste
 * também prova que o realm emite o token no formato que o gateway espera (emissor, audiência
 * {@code lotou-api} e papéis em {@code realm_access.roles}).
 */
@Testcontainers
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class KeycloakIntegrationTests {

    private static final Path REALM_FILE = Path.of("../../infra/keycloak/lotou-realm.json");
    private static final Pattern ACCESS_TOKEN = Pattern.compile("\"access_token\"\\s*:\\s*\"([^\"]+)\"");

    @Container
    static final GenericContainer<?> keycloak = new GenericContainer<>("quay.io/keycloak/keycloak:26.8")
            .withCommand("start-dev", "--import-realm")
            .withCopyFileToContainer(MountableFile.forHostPath(REALM_FILE),
                    "/opt/keycloak/data/import/lotou-realm.json")
            .withExposedPorts(8080)
            .waitingFor(Wait.forHttp("/realms/lotou").forPort(8080).withStartupTimeout(Duration.ofMinutes(3)));

    private static final UpstreamStub eventService = UpstreamStub.start();

    @Value("${local.server.port}")
    private int port;

    private WebTestClient client;

    private static String realmUrl() {
        return "http://" + keycloak.getHost() + ":" + keycloak.getMappedPort(8080) + "/realms/lotou";
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("EVENT_SERVICE_URL", eventService::url);
        registry.add("AUTH_ISSUER", KeycloakIntegrationTests::realmUrl);
        registry.add("AUTH_JWKS_URI", () -> realmUrl() + "/protocol/openid-connect/certs");
    }

    @AfterAll
    static void stopStub() {
        eventService.close();
    }

    @BeforeEach
    void setUp() {
        eventService.reset();
        this.client = WebTestClient.bindToServer().baseUrl("http://localhost:" + this.port).build();
    }

    /** Token da conta de serviço do seed, que tem o papel de produtor (client credentials). */
    private static String producerToken() throws Exception {
        var request = HttpRequest.newBuilder(URI.create(realmUrl() + "/protocol/openid-connect/token"))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(
                        "grant_type=client_credentials&client_id=lotou-seed&client_secret=lotou-seed-dev-secret"))
                .build();
        HttpResponse<String> response = HttpClient.newHttpClient().send(request,
                HttpResponse.BodyHandlers.ofString());
        Matcher matcher = ACCESS_TOKEN.matcher(response.body());
        assertThat(matcher.find()).as("resposta do Keycloak: %s", response.body()).isTrue();
        return matcher.group(1);
    }

    @Test
    void aceitaOTokenDoKeycloakERepassaOAuthorizationAoServico() throws Exception {
        String token = producerToken();
        eventService.respondWith(201, Map.of("Location", "/v1/venues/abc"), "{\"id\":\"abc\"}");

        this.client.post().uri("/api/v1/venues")
                .headers(headers -> headers.setBearerAuth(token))
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{}")
                .exchange()
                .expectStatus().isCreated()
                .expectHeader().valueEquals("Location", "/api/v1/venues/abc");

        // O serviço recebe o mesmo token, para validar de novo (ADR 21).
        assertThat(eventService.lastRequest().header("Authorization")).isEqualTo("Bearer " + token);
    }

    @Test
    void recusaTokenComAssinaturaAdulterada() throws Exception {
        String token = producerToken();
        // Troca um caractere no meio da assinatura. (O último não serve: no base64 ele carrega
        // bits de preenchimento, e trocá-lo pode não mudar a assinatura.)
        int position = token.lastIndexOf('.') + 20;
        char replacement = token.charAt(position) == 'A' ? 'B' : 'A';
        String tampered = token.substring(0, position) + replacement + token.substring(position + 1);

        this.client.post().uri("/api/v1/venues")
                .headers(headers -> headers.setBearerAuth(tampered))
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized()
                .expectHeader().contentType(MediaType.APPLICATION_PROBLEM_JSON);

        assertThat(eventService.requests()).isEmpty();
    }

    @Test
    void recusaTokenDeOutroEmissor() {
        // Assinado por outra chave e com outro emissor: um JWT bem formado, mas que não é nosso.
        String foreign = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Im91dHJvIn0"
                + ".eyJpc3MiOiJodHRwOi8vb3V0cm8tZW1pc3Nvci50ZXN0Iiwic3ViIjoieCIsImF1ZCI6ImxvdG91LWFwaSIsImV4cCI6NDEwMjQ0NDgwMH0"
                + ".c2lnbmF0dXJh";

        this.client.post().uri("/api/v1/venues")
                .headers(headers -> headers.setBearerAuth(foreign))
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{}")
                .exchange()
                .expectStatus().isUnauthorized();

        assertThat(eventService.requests()).isEmpty();
    }

    @Test
    void rotaPublicaFuncionaSemToken() {
        this.client.get().uri("/api/v1/shows").exchange().expectStatus().isOk();
        assertThat(eventService.lastRequest().path()).isEqualTo("/v1/shows");
    }
}

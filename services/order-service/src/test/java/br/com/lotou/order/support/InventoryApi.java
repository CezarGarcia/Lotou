package br.com.lotou.order.support;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.UUID;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** O que os testes fazem direto no inventory-service de verdade: reservar e consultar. */
public final class InventoryApi {

    /** A resposta HTTP do inventory, com o corpo já lido como JSON. */
    public record Response(int status, JsonNode body) {
    }

    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    private final String baseUrl;
    private final Neighbours neighbours;

    public InventoryApi(String baseUrl, Neighbours neighbours) {
        this.baseUrl = baseUrl;
        this.neighbours = neighbours;
    }

    /** Reserva {@code quantity} ingressos de pista como o comprador e devolve o ID da reserva. */
    public UUID reserve(String buyer, Neighbours.Show show, int quantity) {
        return reserved(reserve(buyer, show, "\"quantity\": " + quantity, Cpfs.next()));
    }

    public UUID reserveSeats(String buyer, Neighbours.Show show, String... seats) {
        return reserved(reserve(buyer, show, "\"seats\": [\"" + String.join("\", \"", seats) + "\"]", Cpfs.next()));
    }

    /**
     * Reserva como a loja reserva: logo depois da abertura, o estoque ainda pode estar sendo
     * carregado no Redis (503 {@code inventory-loading}), e a mesma requisição, com a mesma
     * Idempotency-Key, é repetida em instantes.
     */
    public Response reserve(String buyer, Neighbours.Show show, String selection, String cpf) {
        String body = """
                {"showId": "%s", "sectorId": "%s", %s, "cpf": "%s"}
                """.formatted(show.id(), show.sectorId(), selection, cpf);
        String key = UUID.randomUUID().toString();
        for (int attempt = 1;; attempt++) {
            Response response = send(HttpRequest.newBuilder(URI.create(this.baseUrl + "/v1/reservations"))
                    .header("Authorization", "Bearer " + this.neighbours.token(buyer, "buyer"))
                    .header("Idempotency-Key", key)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body)));
            boolean loading = response.status() == 503 && response.body() != null
                    && "urn:lotou:problem:inventory-loading".equals(response.body().path("type").asString());
            if (!loading || attempt == 20) {
                return response;
            }
            try {
                Thread.sleep(100);
            }
            catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return response;
            }
        }
    }

    private static UUID reserved(Response response) {
        if (response.status() != 201) {
            throw new IllegalStateException("Reserva recusada: " + response);
        }
        return UUID.fromString(response.body().get("id").asString());
    }

    /** O setor único do show, como a loja o vê: {@code sale}, {@code available}... */
    public JsonNode sector(Neighbours.Show show) {
        Response response = send(HttpRequest.newBuilder(URI.create(this.baseUrl + "/v1/availability/" + show.id())).GET());
        return response.status() == 200 ? response.body().get("sectors").get(0) : null;
    }

    /** O estado da reserva no inventory, lido pela API interna. */
    public String reservationStatus(UUID reservationId) {
        return internal("GET", "/internal/v1/reservations/" + reservationId).body()
                .get("reservation").get("status").asString();
    }

    /** Libera a reserva pelo comando da saga, e espera o inventory aplicá-lo. */
    public void release(UUID reservationId) {
        String orderId = UUID.randomUUID().toString();
        String command = """
                {"eventId": "%s", "type": "ReleaseReservation", "version": 1, "occurredAt": "%s",
                 "payload": {"orderId": "%s", "reservationId": "%s", "reason": "PAYMENT_DECLINED"}}
                """.formatted(UUID.randomUUID(), java.time.Instant.now(), orderId, reservationId);
        Contracts.assertValid("inventory.commands", "ReleaseReservation", command);
        TestKafka.send("inventory.commands", orderId, command);
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(20))
                .until(() -> "RELEASED".equals(reservationStatus(reservationId)));
    }

    private Response internal(String method, String path) {
        return send(HttpRequest.newBuilder(URI.create(this.baseUrl + path))
                .header("Authorization", "Bearer " + this.neighbours.token("service-account", "service"))
                .method(method, HttpRequest.BodyPublishers.noBody()));
    }

    private static Response send(HttpRequest.Builder request) {
        try {
            HttpResponse<String> response = HTTP.send(request.timeout(Duration.ofSeconds(20)).build(),
                    HttpResponse.BodyHandlers.ofString());
            return new Response(response.statusCode(),
                    response.body().isBlank() ? null : JSON.readTree(response.body()));
        }
        catch (IOException ex) {
            throw new IllegalStateException(ex);
        }
        catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(ex);
        }
    }
}

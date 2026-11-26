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

    public Response reserve(String buyer, Neighbours.Show show, String selection, String cpf) {
        String body = """
                {"showId": "%s", "sectorId": "%s", %s, "cpf": "%s"}
                """.formatted(show.id(), show.sectorId(), selection, cpf);
        return send(HttpRequest.newBuilder(URI.create(this.baseUrl + "/v1/reservations"))
                .header("Authorization", "Bearer " + this.neighbours.token(buyer, "buyer"))
                .header("Idempotency-Key", UUID.randomUUID().toString())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)));
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

    /** Libera a reserva, como se o prazo dela tivesse acabado. */
    public void release(UUID reservationId) {
        internal("POST", "/internal/v1/reservations/" + reservationId + "/release");
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

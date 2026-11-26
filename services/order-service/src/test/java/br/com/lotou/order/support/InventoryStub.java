package br.com.lotou.order.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

/**
 * Um inventory-service de mentira, para provocar o que o de verdade não faz sob encomenda: ficar
 * fora do ar, perder a resposta de uma confirmação ou deixar a reserva expirar no meio do checkout.
 * Guarda o estado de cada reserva e segue o contrato da API interna.
 */
public final class InventoryStub implements AutoCloseable {

    /** Como o stub responde às próximas chamadas. */
    public enum Mode {
        HEALTHY,
        /** Responde 503 sem fazer nada. */
        DOWN,
        /** Aplica a confirmação, mas responde 503: a resposta "se perdeu". */
        CONFIRM_RESPONSE_LOST
    }

    private record Held(String buyerId, UUID showId, UUID sectorId, List<String> seats, long unitPriceCents) {
    }

    private final HttpServer server;
    private final Map<UUID, Held> reservations = new ConcurrentHashMap<>();
    private final Map<UUID, String> statuses = new ConcurrentHashMap<>();
    private final List<String> calls = new CopyOnWriteArrayList<>();
    private volatile Mode mode = Mode.HEALTHY;

    private InventoryStub(HttpServer server) {
        this.server = server;
    }

    public static InventoryStub start() {
        try {
            var stub = new InventoryStub(HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0));
            stub.server.createContext("/internal/v1/reservations/", stub::handle);
            stub.server.start();
            return stub;
        }
        catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }

    public String url() {
        return "http://127.0.0.1:" + this.server.getAddress().getPort();
    }

    public void mode(Mode mode) {
        this.mode = mode;
    }

    public void reset() {
        this.mode = Mode.HEALTHY;
        this.calls.clear();
    }

    /** Uma reserva de pista segurada pelo comprador. */
    public UUID hold(String buyerId, int quantity, long unitPriceCents) {
        return hold(buyerId, UUID.randomUUID(), UUID.randomUUID(), java.util.Collections.nCopies(quantity, null),
                unitPriceCents);
    }

    /** Uma reserva de cadeiras segurada pelo comprador, num show e setor definidos. */
    public UUID hold(String buyerId, UUID showId, UUID sectorId, List<String> seats, long unitPriceCents) {
        UUID id = UUID.randomUUID();
        this.reservations.put(id, new Held(buyerId, showId, sectorId, seats, unitPriceCents));
        this.statuses.put(id, "HELD");
        return id;
    }

    /** Muda o estado da reserva por fora, como o job de expiração do inventory faria. */
    public void expire(UUID reservationId) {
        this.statuses.put(reservationId, "EXPIRED");
    }

    public String statusOf(UUID reservationId) {
        return this.statuses.get(reservationId);
    }

    /** Quantas vezes {@code action} ("confirm" ou "release") foi chamada para a reserva. */
    public long calls(String action, UUID reservationId) {
        return this.calls.stream().filter((action + " " + reservationId)::equals).count();
    }

    private void handle(HttpExchange exchange) throws IOException {
        String[] parts = exchange.getRequestURI().getPath().substring("/internal/v1/reservations/".length()).split("/");
        UUID id = UUID.fromString(parts[0]);
        String action = parts.length > 1 ? parts[1] : "get";
        this.calls.add(action + " " + id);
        exchange.getRequestBody().readAllBytes();

        Held held = this.reservations.get(id);
        if (this.mode == Mode.DOWN) {
            respond(exchange, 503, "{\"status\": 503}");
        }
        else if (held == null) {
            respond(exchange, 404, problem("not-found", 404));
        }
        else if (action.equals("get")) {
            respond(exchange, 200, snapshot(id, held));
        }
        else {
            String target = action.equals("confirm") ? "CONFIRMED" : "RELEASED";
            String current = this.statuses.get(id);
            if (!current.equals("HELD") && !current.equals(target)) {
                respond(exchange, 409, problem("reservation-not-held", 409));
                return;
            }
            this.statuses.put(id, target);
            if (this.mode == Mode.CONFIRM_RESPONSE_LOST && action.equals("confirm")) {
                respond(exchange, 503, "{\"status\": 503}");
                return;
            }
            respond(exchange, 200, snapshot(id, held));
        }
    }

    private String snapshot(UUID id, Held held) {
        var items = new StringBuilder();
        for (String seat : held.seats()) {
            items.append(items.isEmpty() ? "" : ",").append("""
                    {"lotId": "%s", "lotName": "Lote único", "seat": %s, "unitPriceCents": %d}
                    """.formatted(UUID.nameUUIDFromBytes(id.toString().getBytes(StandardCharsets.UTF_8)),
                    seat == null ? "null" : "\"" + seat + "\"", held.unitPriceCents()));
        }
        return """
                {"buyerId": "%s", "reservation": {"id": "%s", "status": "%s", "showId": "%s", "sectorId": "%s",
                 "sectorName": "Setor de teste", "quantity": %d, "totalCents": %d, "expiresAt": "%s",
                 "createdAt": "%s", "items": [%s]}}
                """.formatted(held.buyerId(), id, this.statuses.get(id), held.showId(), held.sectorId(),
                held.seats().size(), held.unitPriceCents() * held.seats().size(), Instant.now().plusSeconds(600),
                Instant.now(), items);
    }

    private static String problem(String slug, int status) {
        return """
                {"type": "urn:lotou:problem:%s", "title": "Problema", "status": %d, "detail": "Detalhe do inventory."}
                """.formatted(slug, status);
    }

    private static void respond(HttpExchange exchange, int status, String json) throws IOException {
        try (exchange) {
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type",
                    status >= 400 && status < 500 ? "application/problem+json" : "application/json");
            exchange.sendResponseHeaders(status, body.length);
            exchange.getResponseBody().write(body);
        }
    }

    @Override
    public void close() {
        this.server.stop(0);
    }
}

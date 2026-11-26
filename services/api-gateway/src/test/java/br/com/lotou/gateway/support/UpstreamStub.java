package br.com.lotou.gateway.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import com.sun.net.httpserver.HttpServer;

/**
 * Um serviço de destino de mentira: um servidor HTTP real, numa porta livre, que registra o que
 * recebeu do gateway e responde o que o teste mandar.
 */
public final class UpstreamStub implements AutoCloseable {

    /** O que o gateway repassou ao serviço. */
    public record ReceivedRequest(String method, String path, String query, Map<String, List<String>> headers) {

        public String header(String name) {
            return this.headers.entrySet().stream()
                    .filter(entry -> entry.getKey().equalsIgnoreCase(name))
                    .map(entry -> entry.getValue().getFirst())
                    .findFirst()
                    .orElse(null);
        }
    }

    private record StubResponse(int status, Map<String, String> headers, String body) {
    }

    private final HttpServer server;
    private final List<ReceivedRequest> requests = new CopyOnWriteArrayList<>();
    private volatile StubResponse response = new StubResponse(200, Map.of(), "{}");

    private UpstreamStub(HttpServer server) {
        this.server = server;
    }

    public static UpstreamStub start() {
        try {
            var stub = new UpstreamStub(HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0));
            stub.server.createContext("/", exchange -> {
                stub.requests.add(new ReceivedRequest(exchange.getRequestMethod(),
                        exchange.getRequestURI().getPath(), exchange.getRequestURI().getQuery(),
                        Map.copyOf(exchange.getRequestHeaders())));
                exchange.getRequestBody().readAllBytes();

                StubResponse current = stub.response;
                byte[] body = current.body().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                current.headers().forEach(exchange.getResponseHeaders()::set);
                exchange.sendResponseHeaders(current.status(), body.length);
                try (var out = exchange.getResponseBody()) {
                    out.write(body);
                }
            });
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

    public void respondWith(int status, Map<String, String> headers, String body) {
        this.response = new StubResponse(status, headers, body);
    }

    public void reset() {
        this.requests.clear();
        this.response = new StubResponse(200, Map.of(), "{}");
    }

    public List<ReceivedRequest> requests() {
        return List.copyOf(this.requests);
    }

    public ReceivedRequest lastRequest() {
        return this.requests.getLast();
    }

    @Override
    public void close() {
        this.server.stop(0);
    }
}

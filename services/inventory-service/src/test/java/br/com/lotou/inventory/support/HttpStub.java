package br.com.lotou.inventory.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

import com.sun.net.httpserver.HttpServer;

/**
 * Um serviço vizinho de mentira: um servidor HTTP real, numa porta livre, que registra o que
 * recebeu e responde o JSON que o teste definir para cada caminho.
 */
public final class HttpStub implements AutoCloseable {

    /** O que chegou ao serviço. */
    public record Received(String method, String path, String query, String authorization) {
    }

    private final HttpServer server;
    private final List<Received> requests = new CopyOnWriteArrayList<>();

    private HttpStub(HttpServer server) {
        this.server = server;
    }

    public static HttpStub start() {
        try {
            var stub = new HttpStub(HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0));
            stub.server.start();
            return stub;
        }
        catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }

    /** Responde {@code path} com o JSON que {@code handler} devolver para cada requisição. */
    public HttpStub on(String path, Function<Received, String> handler) {
        this.server.createContext(path, exchange -> {
            var received = new Received(exchange.getRequestMethod(), exchange.getRequestURI().getPath(),
                    exchange.getRequestURI().getQuery(), exchange.getRequestHeaders().getFirst("Authorization"));
            this.requests.add(received);
            exchange.getRequestBody().readAllBytes();
            byte[] body = handler.apply(received).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (var out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        return this;
    }

    public String url() {
        return "http://127.0.0.1:" + this.server.getAddress().getPort();
    }

    public List<Received> requests(String path) {
        return this.requests.stream().filter(request -> request.path().equals(path)).toList();
    }

    public void clear() {
        this.requests.clear();
    }

    @Override
    public void close() {
        this.server.stop(0);
    }
}

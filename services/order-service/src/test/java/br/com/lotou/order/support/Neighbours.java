package br.com.lotou.order.support;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import tools.jackson.databind.json.JsonMapper;

/**
 * Os vizinhos que os testes simulam, num servidor HTTP real:
 *
 * <ul>
 *   <li>o Keycloak: assina tokens com uma chave RSA própria e publica a chave pública (JWKS), então
 *       o order-service e o inventory-service validam os tokens de verdade;
 *   <li>o event-service: serve o catálogo de shows que o inventory lê por polling.
 * </ul>
 */
public final class Neighbours {

    public static final String ISSUER = "http://idp.test/realms/lotou";
    public static final String AUDIENCE = "lotou-api";

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final HttpServer server;
    private final RSAKey key;
    private final List<Map<String, Object>> catalog = new CopyOnWriteArrayList<>();
    private final AtomicInteger serviceTokens = new AtomicInteger();

    private Neighbours(HttpServer server, RSAKey key) {
        this.server = server;
        this.key = key;
    }

    public static Neighbours start() {
        try {
            RSAKey key = new RSAKeyGenerator(2048).keyID("chave-de-teste").generate();
            // 0.0.0.0: o container do inventory também precisa alcançar este servidor.
            var neighbours = new Neighbours(HttpServer.create(new InetSocketAddress("0.0.0.0", 0), 0), key);
            neighbours.server.createContext("/jwks",
                    exchange -> respond(exchange, new JWKSet(key.toPublicJWK()).toString()));
            neighbours.server.createContext("/token", exchange -> {
                neighbours.serviceTokens.incrementAndGet();
                respond(exchange, JSON.writeValueAsString(Map.of("access_token",
                        neighbours.token("service-account", "service"), "token_type", "Bearer", "expires_in", 300)));
            });
            neighbours.server.createContext("/internal/v1/catalog/shows", exchange -> {
                Map<String, Object> page = new LinkedHashMap<>();
                page.put("items", neighbours.catalog);
                page.put("nextCursor", null);
                respond(exchange, JSON.writeValueAsString(page));
            });
            neighbours.server.start();
            return neighbours;
        }
        catch (IOException | JOSEException ex) {
            throw new IllegalStateException(ex);
        }
    }

    public int port() {
        return this.server.getAddress().getPort();
    }

    /** Um token como o do Keycloak: emissor, audiência, {@code sub} e papéis do realm. */
    public String token(String subject, String... roles) {
        try {
            Instant now = Instant.now();
            var claims = new JWTClaimsSet.Builder()
                    .issuer(ISSUER)
                    .audience(AUDIENCE)
                    .subject(subject)
                    .issueTime(Date.from(now))
                    .expirationTime(Date.from(now.plusSeconds(600)))
                    .claim("realm_access", Map.of("roles", List.of(roles)))
                    .build();
            var jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(this.key.getKeyID()).build(),
                    claims);
            jwt.sign(new RSASSASigner(this.key));
            return jwt.serialize();
        }
        catch (JOSEException ex) {
            throw new IllegalStateException(ex);
        }
    }

    public int serviceTokensIssued() {
        return this.serviceTokens.get();
    }

    /** Um show publicado, com as vendas já abertas, num setor de pista com um lote. */
    public Show showWithPista(int tickets, long priceCents) {
        UUID sectorId = UUID.randomUUID();
        return publish(sectorId, sector(sectorId, "Pista", "GENERAL_ADMISSION", tickets, List.of(), priceCents));
    }

    /** Um show com um setor de cadeira numerada: fileiras A, B, C... */
    public Show showWithSeats(int rows, int seatsPerRow, long priceCents) {
        UUID sectorId = UUID.randomUUID();
        List<Map<String, Object>> layout = new ArrayList<>();
        for (int i = 0; i < rows; i++) {
            layout.add(Map.of("label", String.valueOf((char) ('A' + i)), "seatCount", seatsPerRow));
        }
        return publish(sectorId, sector(sectorId, "Cadeira", "RESERVED_SEATING", rows * seatsPerRow, layout,
                priceCents));
    }

    private static Map<String, Object> sector(UUID id, String name, String kind, int capacity,
            List<Map<String, Object>> rows, long priceCents) {
        Map<String, Object> lot = new LinkedHashMap<>();
        lot.put("id", UUID.randomUUID().toString());
        lot.put("name", "Lote único");
        lot.put("priceCents", priceCents);
        lot.put("quantity", capacity);
        lot.put("opensAt", null);
        return Map.of("id", id.toString(), "name", name, "kind", kind, "capacity", capacity, "rows", rows, "lots",
                List.of(lot));
    }

    private Show publish(UUID sectorId, Map<String, Object> sector) {
        UUID showId = UUID.randomUUID();
        Instant now = Instant.now();
        Map<String, Object> show = new LinkedHashMap<>();
        show.put("id", showId.toString());
        show.put("producerId", "produtor-1");
        show.put("status", "PUBLISHED");
        show.put("version", 2);
        show.put("updatedAt", now.toString());
        show.put("startsAt", now.plusSeconds(60L * 86_400).toString());
        show.put("salesStartAt", now.minusSeconds(60).toString());
        show.put("salesEndAt", now.plusSeconds(60L * 86_400).toString());
        show.put("highDemand", false);
        show.put("sectors", List.of(sector));
        this.catalog.add(show);
        return new Show(showId, sectorId);
    }

    /** Um show publicado no catálogo de teste. */
    public record Show(UUID id, UUID sectorId) {
    }

    private static void respond(HttpExchange exchange, String json) {
        try (exchange) {
            exchange.getRequestBody().readAllBytes();
            byte[] body = json.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
        }
        catch (IOException ex) {
            throw new UncheckedIOException(ex);
        }
    }
}

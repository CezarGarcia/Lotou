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
 *   <li>o event-service: publica shows em {@code shows.catalog}, que o inventory lê.
 * </ul>
 */
public final class Neighbours {

    public static final String ISSUER = "http://idp.test/realms/lotou";
    public static final String AUDIENCE = "lotou-api";

    private static final JsonMapper JSON = JsonMapper.builder().build();

    private final HttpServer server;
    private final RSAKey key;
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

    /**
     * Publica o show em {@code shows.catalog}, como o event-service publicaria: o inventory de
     * verdade lê o tópico e monta a cópia local.
     */
    private Show publish(UUID sectorId, Map<String, Object> sector) {
        UUID showId = UUID.randomUUID();
        Instant now = Instant.now();
        Map<String, Object> show = new LinkedHashMap<>();
        show.put("showId", showId.toString());
        show.put("version", 2);
        show.put("producerId", "produtor-1");
        show.put("status", "PUBLISHED");
        show.put("title", "Show de teste");
        show.put("artist", "Artista de teste");
        show.put("startsAt", now.plusSeconds(60L * 86_400).toString());
        show.put("doorsOpenAt", null);
        show.put("salesStartAt", now.minusSeconds(60).toString());
        show.put("salesEndAt", now.plusSeconds(59L * 86_400).toString());
        show.put("highDemand", false);
        show.put("venue", Map.of("id", UUID.randomUUID().toString(), "name", "Arena de teste", "city", "Recife",
                "state", "PE", "timezone", "America/Recife"));
        show.put("sectors", List.of(sector));
        show.put("updatedAt", now.toString());
        Map<String, Object> envelope = new LinkedHashMap<>();
        envelope.put("eventId", UUID.randomUUID().toString());
        envelope.put("type", "ShowPublished");
        envelope.put("version", 1);
        envelope.put("occurredAt", now.toString());
        envelope.put("payload", show);
        String message = JSON.writeValueAsString(envelope);
        Contracts.assertValid("shows.catalog", "ShowPublished", message);
        TestKafka.send("shows.catalog", showId.toString(), message);
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

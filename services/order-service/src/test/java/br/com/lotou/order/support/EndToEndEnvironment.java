package br.com.lotou.order.support;

import java.time.Duration;

import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.MountableFile;

import org.springframework.test.context.DynamicPropertyRegistry;

/**
 * O ambiente dos testes de integração do order-service, criado uma vez por execução:
 *
 * <ul>
 *   <li>um Postgres real, com um banco para o order-service e outro para o inventory-service;
 *   <li>um Redis real, o redis-core do inventory (reserva em Lua e stream para o Postgres);
 *   <li>o inventory-service de verdade, rodando a imagem Docker dele;
 *   <li>os {@link Neighbours}: o emissor de tokens e o catálogo de shows.
 * </ul>
 *
 * <p>A imagem do inventory precisa existir antes: {@code make test-order-service} a constrói.
 */
public final class EndToEndEnvironment {

    private static final String INVENTORY_IMAGE = System.getProperty("lotou.inventory.image",
            "lotou-inventory-service:latest");
    /** Como um container alcança o host dos testes (Docker 20.10+). */
    private static final String HOST = "host.docker.internal";

    public static final Neighbours NEIGHBOURS = Neighbours.start();

    private static final Network NETWORK = Network.newNetwork();

    public static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18-alpine")
            .withNetwork(NETWORK)
            .withNetworkAliases("postgres")
            .withCopyFileToContainer(MountableFile.forClasspathResource("create-inventory-db.sql"),
                    "/docker-entrypoint-initdb.d/create-inventory-db.sql");

    public static final GenericContainer<?> REDIS = new GenericContainer<>("redis:8.8-alpine")
            .withNetwork(NETWORK)
            .withNetworkAliases("redis-core")
            .withCommand("redis-server", "--maxmemory-policy", "noeviction");

    public static final GenericContainer<?> INVENTORY = new GenericContainer<>(INVENTORY_IMAGE)
            .withNetwork(NETWORK)
            .withExtraHost(HOST, "host-gateway")
            .withExposedPorts(8082)
            .withEnv("DATABASE_URL", "jdbc:postgresql://postgres:5432/inventory")
            .withEnv("DATABASE_USERNAME", POSTGRES.getUsername())
            .withEnv("DATABASE_PASSWORD", POSTGRES.getPassword())
            .withEnv("AUTH_ISSUER", Neighbours.ISSUER)
            .withEnv("AUTH_JWKS_URI", neighbour("/jwks"))
            .withEnv("AUTH_TOKEN_URI", neighbour("/token"))
            .withEnv("EVENT_SERVICE_URL", neighbour(""))
            .withEnv("REDIS_URL", "redis://redis-core:6379")
            // Jobs rápidos: um show publicado no teste fica à venda em menos de um segundo.
            .withEnv("CATALOG_POLL_INTERVAL", "300ms")
            .withEnv("LIFECYCLE_INTERVAL", "200ms")
            .withEnv("OTEL_JAVAAGENT_ENABLED", "false")
            .waitingFor(Wait.forHttp("/actuator/health/readiness").forPort(8082)
                    .withStartupTimeout(Duration.ofMinutes(2)));

    static {
        POSTGRES.start();
        REDIS.start();
        INVENTORY.start();
    }

    private EndToEndEnvironment() {
    }

    private static String neighbour(String path) {
        return "http://" + HOST + ":" + NEIGHBOURS.port() + path;
    }

    public static String inventoryUrl() {
        return "http://" + INVENTORY.getHost() + ":" + INVENTORY.getMappedPort(8082);
    }

    /** Aponta o order-service para o Postgres e para os vizinhos de teste. */
    public static void configure(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("AUTH_ISSUER", () -> Neighbours.ISSUER);
        registry.add("AUTH_JWKS_URI", () -> "http://localhost:" + NEIGHBOURS.port() + "/jwks");
        registry.add("AUTH_TOKEN_URI", () -> "http://localhost:" + NEIGHBOURS.port() + "/token");
        registry.add("lotou.order.jobs.enabled", () -> "false");
    }
}

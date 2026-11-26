package br.com.lotou.order.support;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.Network;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.kafka.KafkaContainer;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.MountableFile;

import org.springframework.test.context.DynamicPropertyRegistry;

/**
 * O ambiente dos testes de integração do order-service, criado uma vez por execução:
 *
 * <ul>
 *   <li>um Postgres real, com um banco para o order-service e outro para o inventory-service;
 *   <li>um Kafka real, com os tópicos de contracts/README.md criados como no Compose;
 *   <li>os {@link Neighbours}: o emissor de tokens dos testes;
 *   <li>sob demanda ({@link Inventory}), o inventory-service de verdade, a partir da imagem Docker
 *       dele, com o Redis que ele usa. Só os testes de ponta a ponta o sobem.
 * </ul>
 */
public final class EndToEndEnvironment {

    /** Como um container alcança o host dos testes (Docker 20.10+). */
    private static final String HOST = "host.docker.internal";

    private static final List<String> TOPICS = List.of("shows.catalog", "order.events", "payment.commands",
            "payment.events", "inventory.commands", "inventory.events");

    public static final Neighbours NEIGHBOURS = Neighbours.start();

    static final Network NETWORK = Network.newNetwork();

    public static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer("postgres:18-alpine")
            .withNetwork(NETWORK)
            .withNetworkAliases("postgres")
            .withCopyFileToContainer(MountableFile.forClasspathResource("create-inventory-db.sql"),
                    "/docker-entrypoint-initdb.d/create-inventory-db.sql");

    /** O endereço {@code kafka:9093} é o que os outros containers da rede usam. */
    public static final KafkaContainer KAFKA = new KafkaContainer("apache/kafka:4.2.0")
            .withNetwork(NETWORK)
            .withNetworkAliases("kafka")
            .withListener("kafka:19092")
            .withEnv("KAFKA_AUTO_CREATE_TOPICS_ENABLE", "false");

    static {
        POSTGRES.start();
        KAFKA.start();
        createTopics();
    }

    private EndToEndEnvironment() {
    }

    /** Aponta o order-service para o Postgres, o Kafka e os vizinhos de teste. */
    public static void configure(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", POSTGRES::getJdbcUrl);
        registry.add("spring.datasource.username", POSTGRES::getUsername);
        registry.add("spring.datasource.password", POSTGRES::getPassword);
        registry.add("spring.kafka.bootstrap-servers", KAFKA::getBootstrapServers);
        registry.add("AUTH_ISSUER", () -> Neighbours.ISSUER);
        registry.add("AUTH_JWKS_URI", () -> "http://localhost:" + NEIGHBOURS.port() + "/jwks");
        registry.add("AUTH_TOKEN_URI", () -> "http://localhost:" + NEIGHBOURS.port() + "/token");
        // Sem jobs agendados: os testes chamam o relay e o job de prazos quando querem.
        registry.add("lotou.order.jobs.enabled", () -> "false");
    }

    private static void createTopics() {
        try (AdminClient admin = AdminClient.create(Map.of(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG,
                KAFKA.getBootstrapServers()))) {
            admin.createTopics(TOPICS.stream()
                    .flatMap(topic -> Stream.of(topic, topic + ".dlt"))
                    .map(topic -> new NewTopic(topic, 3, (short) 1))
                    .toList()).all().get();
        }
        catch (Exception ex) {
            throw new IllegalStateException("Não foi possível criar os tópicos de teste", ex);
        }
    }

    /**
     * O inventory-service de verdade, a partir da imagem Docker dele ({@code make test-order-service}
     * a constrói). Sobe na primeira vez que um teste pede o endereço.
     */
    public static final class Inventory {

        private static final String IMAGE = System.getProperty("lotou.inventory.image",
                "lotou-inventory-service:latest");

        public static final GenericContainer<?> REDIS = new GenericContainer<>("redis:8.8-alpine")
                .withNetwork(NETWORK)
                .withNetworkAliases("redis-core")
                .withCommand("redis-server", "--maxmemory-policy", "noeviction");

        public static final GenericContainer<?> CONTAINER = new GenericContainer<>(IMAGE)
                .withNetwork(NETWORK)
                .withExtraHost(HOST, "host-gateway")
                .withExposedPorts(8082)
                .withEnv("DATABASE_URL", "jdbc:postgresql://postgres:5432/inventory")
                .withEnv("DATABASE_USERNAME", POSTGRES.getUsername())
                .withEnv("DATABASE_PASSWORD", POSTGRES.getPassword())
                .withEnv("AUTH_ISSUER", Neighbours.ISSUER)
                .withEnv("AUTH_JWKS_URI", neighbour("/jwks"))
                .withEnv("AUTH_TOKEN_URI", neighbour("/token"))
                .withEnv("REDIS_URL", "redis://redis-core:6379")
                .withEnv("KAFKA_BROKERS", "kafka:19092")
                // Jobs rápidos: um show publicado no teste fica à venda em menos de um segundo.
                .withEnv("LIFECYCLE_INTERVAL", "200ms")
                .withEnv("OTEL_JAVAAGENT_ENABLED", "false")
                .waitingFor(Wait.forHttp("/actuator/health/readiness").forPort(8082)
                        .withStartupTimeout(Duration.ofMinutes(2)));

        static {
            REDIS.start();
            CONTAINER.start();
        }

        private Inventory() {
        }

        public static String url() {
            return "http://" + CONTAINER.getHost() + ":" + CONTAINER.getMappedPort(8082);
        }

        private static String neighbour(String path) {
            return "http://" + HOST + ":" + NEIGHBOURS.port() + path;
        }
    }
}

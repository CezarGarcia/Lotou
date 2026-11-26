package br.com.lotou.inventory.support;

import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.testcontainers.kafka.KafkaContainer;

/**
 * Um Kafka real para todos os testes, com os tópicos de contracts/README.md criados como no
 * Compose (a criação automática fica desligada, como lá).
 */
public final class SharedKafka {

    private static final List<String> TOPICS = List.of("shows.catalog", "inventory.commands", "inventory.events");

    private static final KafkaContainer KAFKA = new KafkaContainer("apache/kafka:4.2.0")
            .withEnv("KAFKA_AUTO_CREATE_TOPICS_ENABLE", "false");

    static {
        KAFKA.start();
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

    private SharedKafka() {
    }

    public static String bootstrapServers() {
        return KAFKA.getBootstrapServers();
    }
}

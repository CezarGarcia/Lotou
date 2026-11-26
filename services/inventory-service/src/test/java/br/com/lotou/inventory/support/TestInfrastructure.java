package br.com.lotou.inventory.support;

import java.time.Clock;
import java.util.UUID;

import org.testcontainers.containers.GenericContainer;
import org.testcontainers.postgresql.PostgreSQLContainer;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistrar;

/**
 * O que os testes de integração trocam: um Postgres e um Redis reais em containers por contexto,
 * um Kafka real compartilhado ({@link SharedKafka}) e um relógio ajustável.
 */
@TestConfiguration(proxyBeanMethods = false)
public class TestInfrastructure {

    @Bean
    @ServiceConnection
    PostgreSQLContainer postgres() {
        return new PostgreSQLContainer("postgres:18-alpine");
    }

    /** Mesma imagem e mesma política do redis-core do Compose: nunca descarta chave. */
    @Bean
    @ServiceConnection(name = "redis")
    GenericContainer<?> redis() {
        return new GenericContainer<>("redis:8.8-alpine")
                .withCommand("redis-server", "--maxmemory-policy", "noeviction")
                .withExposedPorts(6379);
    }

    /**
     * O Kafka é um só para todos os contextos de teste; cada contexto tem o próprio consumer group,
     * para um contexto não consumir as mensagens que o teste de outro publicou.
     */
    @Bean
    DynamicPropertyRegistrar kafka() {
        return registry -> {
            registry.add("spring.kafka.bootstrap-servers", SharedKafka::bootstrapServers);
            registry.add("spring.kafka.consumer.group-id", () -> "inventory-test-" + UUID.randomUUID());
        };
    }

    @Bean
    MutableClock mutableClock() {
        return new MutableClock();
    }

    @Bean
    @Primary
    Clock clock(MutableClock clock) {
        return clock;
    }
}

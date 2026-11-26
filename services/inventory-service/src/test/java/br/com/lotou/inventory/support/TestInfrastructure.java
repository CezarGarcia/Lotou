package br.com.lotou.inventory.support;

import java.time.Clock;

import org.testcontainers.containers.GenericContainer;
import org.testcontainers.postgresql.PostgreSQLContainer;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/**
 * O que os testes de integração trocam: um Postgres e um Redis reais em containers, e um relógio
 * ajustável.
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

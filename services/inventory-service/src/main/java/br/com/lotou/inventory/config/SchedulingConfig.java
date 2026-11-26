package br.com.lotou.inventory.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** Liga os jobs agendados (leitura do catálogo, ciclo dos lotes e expiração de reservas). */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(name = "lotou.inventory.jobs.enabled", havingValue = "true", matchIfMissing = true)
public class SchedulingConfig {
}

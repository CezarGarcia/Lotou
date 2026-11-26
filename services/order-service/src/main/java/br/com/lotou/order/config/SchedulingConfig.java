package br.com.lotou.order.config;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/** Liga os jobs agendados (recuperação de pedidos pendentes). */
@Configuration(proxyBeanMethods = false)
@EnableScheduling
@ConditionalOnProperty(name = "lotou.order.jobs.enabled", havingValue = "true", matchIfMissing = true)
public class SchedulingConfig {
}

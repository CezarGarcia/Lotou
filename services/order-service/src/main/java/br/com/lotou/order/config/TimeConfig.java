package br.com.lotou.order.config;

import java.time.Clock;

import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** O relógio é um bean para os testes poderem adiantar o tempo (expiração de reserva). */
@Configuration(proxyBeanMethods = false)
public class TimeConfig {

    @Bean
    @ConditionalOnMissingBean
    Clock clock() {
        return Clock.systemUTC();
    }
}

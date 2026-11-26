package br.com.lotou.order.support;

import java.time.Clock;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** O que os testes de integração trocam na aplicação: o relógio. */
@TestConfiguration(proxyBeanMethods = false)
public class TestBeans {

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

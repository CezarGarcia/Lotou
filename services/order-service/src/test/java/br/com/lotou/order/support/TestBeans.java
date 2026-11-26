package br.com.lotou.order.support;

import java.time.Clock;

import br.com.lotou.order.payment.PaymentGateway;

import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;

/** O que os testes de integração trocam na aplicação: o pagamento e o relógio. */
@TestConfiguration(proxyBeanMethods = false)
public class TestBeans {

    @Bean
    ControllablePaymentGateway controllablePaymentGateway() {
        return new ControllablePaymentGateway();
    }

    @Bean
    @Primary
    PaymentGateway paymentGateway(ControllablePaymentGateway gateway) {
        return gateway;
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

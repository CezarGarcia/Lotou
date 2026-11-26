package br.com.lotou.order;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Pedidos, emissão de ingressos e orquestração do checkout.
 *
 * <p>Na fase 1 o checkout é síncrono: o pedido é criado, o pagamento é simulado no próprio
 * serviço e a reserva é confirmada no inventory por HTTP. Na fase 3 isso vira uma saga com Kafka
 * e o payment-mock (ADR 23).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class OrderServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(OrderServiceApplication.class, args);
    }
}

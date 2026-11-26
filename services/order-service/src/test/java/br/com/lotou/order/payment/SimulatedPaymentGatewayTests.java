package br.com.lotou.order.payment;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;

import br.com.lotou.order.config.OrderProperties;
import br.com.lotou.order.payment.PaymentGateway.Result;
import br.com.lotou.order.shared.UuidV7;
import org.junit.jupiter.api.Test;

class SimulatedPaymentGatewayTests {

    private static SimulatedPaymentGateway gateway(int declineRate) {
        return new SimulatedPaymentGateway(new OrderProperties(new OrderProperties.Inventory("http://localhost"),
                new OrderProperties.Checkout(Duration.ofSeconds(30)), new OrderProperties.Payment(declineRate),
                new OrderProperties.Jobs(false)));
    }

    private static List<UUID> orders(int count) {
        return Stream.generate(UuidV7::generate).limit(count).toList();
    }

    @Test
    void aprovaTudoComTaxaZeroERecusaTudoComTaxaCem() {
        assertThat(orders(200)).allMatch(id -> gateway(0).authorize(id, 1_000) == Result.AUTHORIZED);
        assertThat(orders(200)).allMatch(id -> gateway(100).authorize(id, 1_000) == Result.DECLINED);
    }

    @Test
    void recusaPertoDaTaxaConfigurada() {
        var gateway = gateway(30);
        long declined = orders(5_000).stream().filter(id -> gateway.authorize(id, 1_000) == Result.DECLINED).count();

        assertThat(declined).isBetween(1_300L, 1_700L);
    }

    @Test
    void respondeIgualParaOMesmoPedido() {
        var gateway = gateway(50);
        for (UUID id : orders(100)) {
            assertThat(gateway.authorize(id, 1_000)).isEqualTo(gateway.authorize(id, 1_000));
        }
    }
}

package br.com.lotou.order.payment;

import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Component;

/**
 * Pagamento simulado: aprova tudo, menos uma porcentagem configurável de pedidos ({@code
 * lotou.order.payment.decline-rate}), para exercitar a compensação.
 *
 * <p>A resposta depende só do ID do pedido, então é a mesma em toda repetição, como num gateway
 * real que recebe uma chave de idempotência.
 */
@Component
public class SimulatedPaymentGateway implements PaymentGateway {

    private static final Logger log = LoggerFactory.getLogger(SimulatedPaymentGateway.class);

    private final int declineRate;

    public SimulatedPaymentGateway(OrderProperties properties) {
        this.declineRate = properties.payment().declineRate();
    }

    @Override
    public Result authorize(UUID orderId, long amountCents) {
        // Os bits aleatórios do UUID espalham os pedidos de 0 a 99.
        long bucket = Math.floorMod(orderId.getLeastSignificantBits(), 100L);
        return bucket < this.declineRate ? Result.DECLINED : Result.AUTHORIZED;
    }

    @Override
    public void voidAuthorization(UUID orderId) {
        log.info("Autorização de pagamento desfeita: pedido {}", orderId);
    }
}

package br.com.lotou.order.order;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.data.domain.Limit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Retoma os pedidos que ficaram pendentes: o serviço caiu no meio do checkout, ou o inventory não
 * respondeu. Cada pedido é assumido com um update condicional, então várias instâncias podem
 * rodar ao mesmo tempo sem processar o mesmo pedido duas vezes.
 */
@Component
public class OrderRecoveryJob {

    private static final Logger log = LoggerFactory.getLogger(OrderRecoveryJob.class);
    private static final Limit BATCH = Limit.of(100);

    private final OrderRepository orders;
    private final CheckoutService checkout;
    private final OrderProperties properties;
    private final Clock clock;

    public OrderRecoveryJob(OrderRepository orders, CheckoutService checkout, OrderProperties properties,
            Clock clock) {
        this.orders = orders;
        this.checkout = checkout;
        this.properties = properties;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${lotou.order.jobs.recovery-interval:10s}")
    public void run() {
        int recovered = recoverPending();
        if (recovered > 0) {
            log.info("Pedidos pendentes retomados: {}", recovered);
        }
    }

    /** Retoma um lote de pedidos pendentes. Devolve quantos este job assumiu. */
    public int recoverPending() {
        Instant now = this.clock.instant();
        int claimed = 0;
        for (UUID id : this.orders.findRecoverableIds(now, BATCH)) {
            if (this.orders.claim(id, now, now.plus(this.properties.checkout().processingLease())) == 0) {
                continue; // outra instância assumiu, ou o pedido foi concluído
            }
            claimed++;
            try {
                this.checkout.process(id);
            }
            catch (RuntimeException ex) {
                log.warn("Pedido {} continua pendente: {}", id, ex.getMessage());
            }
        }
        return claimed;
    }
}

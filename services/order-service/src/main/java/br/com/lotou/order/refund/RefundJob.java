package br.com.lotou.order.refund;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Anda com os reembolsos: começa os da fila no ritmo configurado ({@code lotou.order.refunds.rate}
 * por segundo), para que o cancelamento de um show com milhares de pedidos não despeje milhares de
 * estornos no gateway de pagamento de uma vez, e pede de novo os estornos sem resposta no prazo.
 *
 * <p>Também confere se algum pedido de show cancelado ficou de fora da fila: um pedido que estava
 * no meio da saga de compra quando o show foi cancelado só confirma depois. Seguro com várias
 * instâncias: cada reembolso é travado e o estado conferido de novo antes de qualquer mudança.
 */
@Component
public class RefundJob {

    private static final Logger log = LoggerFactory.getLogger(RefundJob.class);
    private static final int BATCH = 100;

    private final RefundService refunds;
    private final int rate;

    public RefundJob(RefundService refunds, br.com.lotou.order.config.OrderProperties properties) {
        this.refunds = refunds;
        this.rate = properties.refunds().rate();
    }

    @Scheduled(fixedRateString = "${lotou.order.jobs.refund-interval:1s}")
    public void run() {
        try {
            this.refunds.queueAllCancelledShows();
        }
        catch (RuntimeException ex) {
            log.warn("Não foi possível conferir os shows cancelados: {}", ex.getMessage());
        }
        startQueued();
        resendOverdue();
    }

    /** Começa até {@code rate} reembolsos da fila. Devolve quantos começaram. */
    public int startQueued() {
        int started = 0;
        for (UUID orderId : this.refunds.queued(this.rate)) {
            try {
                if (this.refunds.startQueued(orderId)) {
                    started++;
                }
            }
            catch (RuntimeException ex) {
                log.warn("Não foi possível começar o reembolso do pedido {}: {}", orderId, ex.getMessage());
            }
        }
        return started;
    }

    public void resendOverdue() {
        for (UUID orderId : this.refunds.overdue(BATCH)) {
            try {
                this.refunds.onDeadline(orderId);
            }
            catch (RuntimeException ex) {
                log.warn("Não foi possível pedir de novo o estorno do pedido {}: {}", orderId, ex.getMessage());
            }
        }
    }
}

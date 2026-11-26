package br.com.lotou.order.saga;

import java.time.Clock;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.inventory.InventoryClient;
import br.com.lotou.order.inventory.InventoryClient.InventoryUnavailableException;
import br.com.lotou.order.order.OrderRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.data.domain.Limit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Retoma as sagas cuja resposta não chegou no prazo: o comando se perdeu, o serviço do outro lado
 * estava fora, ou o fato que a saga esperava foi publicado antes de o pedido existir.
 *
 * <p>Para os passos que esperam um fato sobre a reserva, consulta a reserva no inventory antes de
 * decidir, fora da transação. Seguro com várias instâncias: a saga é travada e o prazo conferido de
 * novo antes de qualquer mudança.
 */
@Component
public class SagaDeadlineJob {

    private static final Logger log = LoggerFactory.getLogger(SagaDeadlineJob.class);
    private static final int BATCH = 100;

    private final SagaStateRepository sagas;
    private final OrderRepository orders;
    private final PurchaseSaga saga;
    private final InventoryClient inventory;
    private final Clock clock;

    public SagaDeadlineJob(SagaStateRepository sagas, OrderRepository orders, PurchaseSaga saga,
            InventoryClient inventory, Clock clock) {
        this.sagas = sagas;
        this.orders = orders;
        this.saga = saga;
        this.inventory = inventory;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${lotou.order.jobs.saga-deadline-interval:2s}")
    public void resumeOverdue() {
        List<UUID> overdue = this.sagas.findOverdue(this.clock.instant(), Limit.of(BATCH));
        for (UUID orderId : overdue) {
            try {
                resume(orderId);
            }
            catch (RuntimeException ex) {
                log.warn("Não foi possível retomar a saga do pedido {}: {}", orderId, ex.getMessage());
            }
        }
    }

    void resume(UUID orderId) {
        SagaState current = this.sagas.findById(orderId).orElse(null);
        if (current == null) {
            return;
        }
        PurchaseSaga.ReservationState reservation = PurchaseSaga.ReservationState.UNKNOWN;
        if (PurchaseSaga.needsReservationState(current.getStep())) {
            reservation = reservationState(orderId);
        }
        this.saga.onDeadline(orderId, reservation);
    }

    private PurchaseSaga.ReservationState reservationState(UUID orderId) {
        UUID reservationId = this.orders.findById(orderId).orElseThrow().getReservationId();
        try {
            return this.inventory.find(reservationId)
                    .map(snapshot -> switch (snapshot.reservation().status()) {
                        case "HELD" -> PurchaseSaga.ReservationState.HELD;
                        case "CONFIRMED" -> PurchaseSaga.ReservationState.CONFIRMED;
                        case "RELEASED", "EXPIRED" -> PurchaseSaga.ReservationState.RELEASED;
                        default -> PurchaseSaga.ReservationState.UNKNOWN;
                    })
                    .orElse(PurchaseSaga.ReservationState.UNKNOWN);
        }
        catch (InventoryUnavailableException ex) {
            // Sem a reserva, o comando é repetido; o inventory confirma ou libera de forma idempotente.
            return PurchaseSaga.ReservationState.UNKNOWN;
        }
    }
}

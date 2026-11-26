package br.com.lotou.order.saga;

import java.time.Instant;
import java.util.UUID;

import br.com.lotou.order.order.CancelReason;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Onde a saga de compra de um pedido está, e até quando espera a resposta do passo atual. */
@Entity
@Table(name = "saga_state")
public class SagaState {

    private static final Logger log = LoggerFactory.getLogger(SagaState.class);

    @Id
    private UUID orderId;

    private String saga;

    @Enumerated(EnumType.STRING)
    private SagaStep step;

    private boolean reservationLost;

    @Enumerated(EnumType.STRING)
    private CancelReason cancelReason;

    private int attempts;

    private Instant deadline;

    private Instant startedAt;

    private Instant updatedAt;

    protected SagaState() {
    }

    static SagaState purchase(UUID orderId, Instant now, Instant deadline) {
        var state = new SagaState();
        state.orderId = orderId;
        state.saga = "PURCHASE";
        state.step = SagaStep.AUTHORIZING_PAYMENT;
        state.attempts = 1;
        state.deadline = deadline;
        state.startedAt = now;
        state.updatedAt = now;
        return state;
    }

    /** Vai para o passo seguinte; um passo em andamento ganha prazo novo e zera as tentativas. */
    void moveTo(SagaStep target, Instant now, Instant deadline) {
        if (!this.step.canTransitionTo(target)) {
            log.warn("Transição de passo recusada: saga do pedido {} de {} para {}", this.orderId, this.step, target);
            throw new IllegalStateException("Transição de " + this.step + " para " + target + " fora da tabela");
        }
        this.step = target;
        this.attempts = 1;
        this.deadline = target.isFinal() ? null : deadline;
        this.updatedAt = now;
    }

    /** O comando do passo atual foi enviado de novo. */
    void retried(Instant now, Instant deadline) {
        this.attempts++;
        this.deadline = deadline;
        this.updatedAt = now;
    }

    void markReservationLost(Instant now) {
        this.reservationLost = true;
        this.updatedAt = now;
    }

    void compensateFor(CancelReason reason) {
        this.cancelReason = reason;
    }

    boolean is(SagaStep step) {
        return this.step == step;
    }

    public UUID getOrderId() {
        return this.orderId;
    }

    public SagaStep getStep() {
        return this.step;
    }

    public boolean isReservationLost() {
        return this.reservationLost;
    }

    public CancelReason getCancelReason() {
        return this.cancelReason;
    }

    public int getAttempts() {
        return this.attempts;
    }

    public Instant getDeadline() {
        return this.deadline;
    }

    public Instant getStartedAt() {
        return this.startedAt;
    }
}

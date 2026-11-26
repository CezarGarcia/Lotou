package br.com.lotou.order.saga;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface SagaStateRepository extends JpaRepository<SagaState, UUID> {

    /** Trava a saga: a resposta de um passo e o job de prazos não agem juntos sobre o mesmo pedido. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select s from SagaState s where s.orderId = :orderId")
    Optional<SagaState> lockByOrderId(UUID orderId);

    /** Sagas em andamento cujo prazo venceu: a resposta do passo atual não chegou. */
    @Query("""
            select s.orderId from SagaState s
            where s.deadline < :now and s.step not in (SagaStep.COMPLETED, SagaStep.COMPENSATED)
            order by s.deadline
            """)
    List<UUID> findOverdue(Instant now, Limit limit);
}

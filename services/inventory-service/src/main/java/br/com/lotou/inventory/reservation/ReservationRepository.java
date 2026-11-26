package br.com.lotou.inventory.reservation;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface ReservationRepository extends JpaRepository<Reservation, UUID> {

    /** Trava a reserva: confirmar, liberar e expirar nunca correm juntos na mesma reserva. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from Reservation r where r.id = :id")
    Optional<Reservation> lockById(UUID id);

    /** Já com os itens: a repetição de uma requisição devolve a reserva fora de uma transação. */
    @EntityGraph(attributePaths = "items")
    Optional<Reservation> findByBuyerIdAndIdempotencyKey(String buyerId, String idempotencyKey);

    @Query("""
            select r.id from Reservation r
            where r.status = ReservationStatus.HELD and r.expiresAt <= :now
            order by r.expiresAt
            """)
    List<UUID> findExpiredIds(Instant now, Limit limit);
}

package br.com.lotou.order.order;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.transaction.annotation.Transactional;

public interface OrderRepository extends JpaRepository<Order, UUID> {

    /** Trava o pedido: dois processamentos do mesmo pedido não confirmam nem cancelam juntos. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from Order o where o.id = :id")
    Optional<Order> lockById(UUID id);

    Optional<Order> findByBuyerIdAndIdempotencyKey(String buyerId, String idempotencyKey);

    Optional<Order> findByReservationId(UUID reservationId);

    /** Pedidos do comprador, do mais novo ao mais antigo. O UUID v7 já é ordenado por tempo. */
    @Query("select o from Order o where o.buyerId = :buyerId order by o.id desc")
    List<Order> findByBuyer(String buyerId, Limit limit);

    @Query("select o from Order o where o.buyerId = :buyerId and o.id < :before order by o.id desc")
    List<Order> findByBuyerBefore(String buyerId, UUID before, Limit limit);

    /** Pedidos pendentes que ninguém está processando (o prazo de quem processava venceu). */
    @Query("""
            select o.id from Order o
            where o.status = OrderStatus.PENDING and o.processingUntil < :now
            order by o.processingUntil
            """)
    List<UUID> findRecoverableIds(Instant now, Limit limit);

    /**
     * Assume o processamento de um pedido pendente. É um update condicional: de várias instâncias
     * do job, só uma consegue.
     */
    @Transactional
    @Modifying
    @Query("""
            update Order o set o.processingUntil = :until
            where o.id = :id and o.status = OrderStatus.PENDING and o.processingUntil < :now
            """)
    int claim(UUID id, Instant now, Instant until);
}

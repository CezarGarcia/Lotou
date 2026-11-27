package br.com.lotou.order.order;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface OrderRepository extends JpaRepository<Order, UUID> {

    /** Trava o pedido: dois processamentos do mesmo pedido não confirmam nem cancelam juntos. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select o from Order o where o.id = :id")
    Optional<Order> lockById(UUID id);

    Optional<Order> findByBuyerIdAndIdempotencyKey(String buyerId, String idempotencyKey);

    Optional<Order> findByReservationId(UUID reservationId);

    /** Pedidos do show num estado, do mais novo ao mais antigo, paginados por cursor. */
    @Query("select o from Order o where o.showId = :showId and o.status = :status and (:before is null or o.id < :before) order by o.id desc")
    List<Order> findByShowAndStatus(UUID showId, OrderStatus status, UUID before, Limit limit);

    /** O pedido de um ingresso, travado: a entrada na portaria e o cancelamento não se cruzam. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select t.order from Ticket t where t.id = :ticketId")
    Optional<Order> lockByTicketId(UUID ticketId);

    /** Pedidos do comprador, do mais novo ao mais antigo. O UUID v7 já é ordenado por tempo. */
    @Query("select o from Order o where o.buyerId = :buyerId order by o.id desc")
    List<Order> findByBuyer(String buyerId, Limit limit);

    @Query("select o from Order o where o.buyerId = :buyerId and o.id < :before order by o.id desc")
    List<Order> findByBuyerBefore(String buyerId, UUID before, Limit limit);
}

package br.com.lotou.order.order;

import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface TicketRepository extends JpaRepository<Ticket, UUID> {

    /** Ingressos ativos de outros pedidos para estas cadeiras: deveria ser sempre zero (ADR 4). */
    @Query("""
            select count(t) from Ticket t
            where t.showId = :showId and t.sectorId = :sectorId and t.seatLabel in :seats
              and t.status <> TicketStatus.CANCELLED and t.order.id <> :orderId
            """)
    long countActive(UUID showId, UUID sectorId, List<String> seats, UUID orderId);
}

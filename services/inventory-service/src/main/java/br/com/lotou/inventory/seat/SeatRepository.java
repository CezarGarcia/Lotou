package br.com.lotou.inventory.seat;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface SeatRepository extends JpaRepository<Seat, UUID> {

    /**
     * As cadeiras pedidas, travadas ({@code SELECT ... FOR UPDATE}). Sempre em ordem de ID: duas
     * reservas que disputam as mesmas cadeiras travam na mesma ordem e não entram em deadlock.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("""
            select s from Seat s
            where s.showId = :showId and s.sectorId = :sectorId and s.label in :labels
            order by s.id
            """)
    List<Seat> lockByLabels(UUID showId, UUID sectorId, Collection<String> labels);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select s from Seat s where s.reservationId = :reservationId order by s.id")
    List<Seat> lockByReservation(UUID reservationId);

    @Query("select s from Seat s where s.showId = :showId and s.sectorId = :sectorId order by s.position")
    List<Seat> findBySector(UUID showId, UUID sectorId);
}

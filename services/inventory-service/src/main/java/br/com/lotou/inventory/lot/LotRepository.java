package br.com.lotou.inventory.lot;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface LotRepository extends JpaRepository<Lot, UUID> {

    /**
     * Os lotes de um setor, travados ({@code SELECT ... FOR UPDATE}) e em ordem de virada. Enquanto
     * a transação não termina, outra reserva do mesmo setor espera aqui.
     */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select l from Lot l where l.showId = :showId and l.sectorId = :sectorId order by l.position")
    List<Lot> lockBySector(UUID showId, UUID sectorId);

    @Query("select l from Lot l where l.showId = :showId order by l.sectorId, l.position")
    List<Lot> findByShow(UUID showId);

    /** Setores com um lote agendado cuja data chegou, em shows com as vendas abertas. */
    @Query("""
            select distinct new br.com.lotou.inventory.lot.SectorRef(l.showId, l.sectorId)
            from Lot l
            where l.status = LotStatus.SCHEDULED
              and l.opensAt <= :now
              and exists (select 1 from Show s
                          where s.id = l.showId
                            and s.salesOpenedAt is not null
                            and s.salesClosedAt is null)
            """)
    List<SectorRef> findSectorsDueToTurn(Instant now);
}

package br.com.lotou.inventory.catalog;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;

public interface ShowRepository extends JpaRepository<Show, UUID> {

    /** Trava a linha do show: abrir e encerrar vendas não correm junto com a leitura do catálogo. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select s from Show s where s.id = :id")
    Optional<Show> lockById(UUID id);

    @Query("""
            select s.id from Show s
            where s.salesOpenedAt is null
              and s.status in (ShowStatus.PUBLISHED, ShowStatus.ON_SALE)
              and s.salesStartAt <= :now
              and (s.salesEndAt is null or s.salesEndAt > :now)
            """)
    List<UUID> findIdsDueToOpen(Instant now);

    @Query("""
            select s.id from Show s
            where s.salesOpenedAt is not null
              and s.salesClosedAt is null
              and (s.salesEndAt <= :now
                   or s.status not in (ShowStatus.PUBLISHED, ShowStatus.ON_SALE))
            """)
    List<UUID> findIdsDueToClose(Instant now);
}

package br.com.lotou.inventory.catalog;

import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface SectorRepository extends JpaRepository<Sector, Sector.Key> {

    @Query("select s from Sector s where s.key.showId = :showId order by s.position")
    List<Sector> findByShow(UUID showId);
}

package br.com.lotou.inventory.lot;

import java.time.Instant;
import java.util.UUID;

import br.com.lotou.inventory.catalog.Sector;
import br.com.lotou.inventory.catalog.SectorRepository;
import br.com.lotou.inventory.catalog.Show;
import br.com.lotou.inventory.catalog.ShowRepository;
import br.com.lotou.inventory.shared.problem.Problems;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * A abertura das vendas no Postgres: o primeiro lote de cada setor entra em venda e o show fica
 * marcado como aberto. Os dois motores começam por aqui; o motor Redis, em seguida, carrega o
 * estoque no {@code redis-core}.
 *
 * <p>Trava a linha do show e confere a condição de novo depois de travar: rodar duas vezes, ou em
 * duas instâncias ao mesmo tempo, abre uma vez só.
 */
@Component
public class SalesOpening {

    private static final Logger log = LoggerFactory.getLogger(SalesOpening.class);

    private final ShowRepository shows;
    private final SectorRepository sectors;
    private final LotRepository lots;

    public SalesOpening(ShowRepository shows, SectorRepository sectors, LotRepository lots) {
        this.shows = shows;
        this.sectors = sectors;
        this.lots = lots;
    }

    @Transactional
    public boolean open(UUID showId, Instant now) {
        Show show = this.shows.lockById(showId).orElseThrow(() -> Problems.notFound("Show"));
        if (!show.dueToOpen(now)) {
            return false;
        }
        for (Sector sector : this.sectors.findByShow(showId)) {
            new SectorLots(this.lots.lockBySector(showId, sector.getId())).openSales();
        }
        show.markSalesOpened(now);
        log.info("Vendas abertas: show {}", showId);
        return true;
    }
}

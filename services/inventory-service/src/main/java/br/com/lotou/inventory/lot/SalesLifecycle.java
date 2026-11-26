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

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Abertura das vendas, virada de lote por data, encerramento das vendas e pausa de lote. Cada
 * operação é uma transação que trava o que altera e confere a condição de novo depois de travar:
 * rodar duas vezes, ou em duas instâncias ao mesmo tempo, não muda o resultado.
 */
@Service
public class SalesLifecycle {

    private static final Logger log = LoggerFactory.getLogger(SalesLifecycle.class);

    private final ShowRepository shows;
    private final SectorRepository sectors;
    private final LotRepository lots;

    public SalesLifecycle(ShowRepository shows, SectorRepository sectors, LotRepository lots) {
        this.shows = shows;
        this.sectors = sectors;
        this.lots = lots;
    }

    /** O primeiro lote de cada setor entra em venda. */
    @Transactional
    public boolean openSales(UUID showId, Instant now) {
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

    /** O lote em venda (ou pausado) de cada setor fecha. */
    @Transactional
    public boolean closeSales(UUID showId, Instant now) {
        Show show = this.shows.lockById(showId).orElseThrow(() -> Problems.notFound("Show"));
        if (!show.dueToClose(now)) {
            return false;
        }
        for (Sector sector : this.sectors.findByShow(showId)) {
            new SectorLots(this.lots.lockBySector(showId, sector.getId())).closeSales();
        }
        show.markSalesClosed(now);
        log.info("Vendas encerradas: show {}", showId);
        return true;
    }

    @Transactional
    public boolean turnByDate(SectorRef sector, Instant now) {
        boolean turned = new SectorLots(this.lots.lockBySector(sector.showId(), sector.sectorId()))
                .turnByDate(now);
        if (turned) {
            log.info("Lote virou por data: show {} setor {}", sector.showId(), sector.sectorId());
        }
        return turned;
    }

    /** O produtor pausa um lote em venda: ele deixa de aceitar reservas. */
    @Transactional
    public Lot pause(UUID lotId, String producerId) {
        Lot lot = ownedLot(lotId, producerId);
        new SectorLots(this.lots.lockBySector(lot.getShowId(), lot.getSectorId())).pause(lotId);
        return lot;
    }

    @Transactional
    public Lot resume(UUID lotId, String producerId) {
        Lot lot = ownedLot(lotId, producerId);
        new SectorLots(this.lots.lockBySector(lot.getShowId(), lot.getSectorId())).resume(lotId);
        return lot;
    }

    /** O lote, se o show for deste produtor. Lote de outro produtor é 404, não 403. */
    private Lot ownedLot(UUID lotId, String producerId) {
        Lot lot = this.lots.findById(lotId).orElseThrow(() -> Problems.notFound("Lote"));
        this.shows.findById(lot.getShowId())
                .filter(show -> show.getProducerId().equals(producerId))
                .orElseThrow(() -> Problems.notFound("Lote"));
        return lot;
    }
}

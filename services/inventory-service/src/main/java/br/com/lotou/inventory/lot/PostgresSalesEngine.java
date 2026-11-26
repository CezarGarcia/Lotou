package br.com.lotou.inventory.lot;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import br.com.lotou.inventory.catalog.Sector;
import br.com.lotou.inventory.catalog.SectorRepository;
import br.com.lotou.inventory.catalog.Show;
import br.com.lotou.inventory.catalog.ShowRepository;
import br.com.lotou.inventory.seat.SeatRepository;
import br.com.lotou.inventory.shared.problem.Problems;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Ciclo das vendas e leitura de disponibilidade no Postgres (fase 1). Cada operação é uma transação
 * que trava o que altera e confere a condição de novo depois de travar.
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "postgres")
public class PostgresSalesEngine implements SalesEngine {

    private static final Logger log = LoggerFactory.getLogger(PostgresSalesEngine.class);

    private final SalesOpening opening;
    private final ShowRepository shows;
    private final SectorRepository sectors;
    private final LotRepository lots;
    private final SeatRepository seats;

    public PostgresSalesEngine(SalesOpening opening, ShowRepository shows, SectorRepository sectors,
            LotRepository lots, SeatRepository seats) {
        this.opening = opening;
        this.shows = shows;
        this.sectors = sectors;
        this.lots = lots;
        this.seats = seats;
    }

    @Override
    public boolean openSales(UUID showId, Instant now) {
        return this.opening.open(showId, now);
    }

    @Override
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

    @Override
    @Transactional
    public boolean turnByDate(SectorRef sector, Instant now) {
        boolean turned = new SectorLots(this.lots.lockBySector(sector.showId(), sector.sectorId())).turnByDate(now);
        if (turned) {
            log.info("Lote virou por data: show {} setor {}", sector.showId(), sector.sectorId());
        }
        return turned;
    }

    @Override
    @Transactional
    public LotView pause(UUID lotId, String producerId) {
        Lot lot = ownedLot(lotId, producerId, this.lots, this.shows);
        new SectorLots(this.lots.lockBySector(lot.getShowId(), lot.getSectorId())).pause(lotId);
        return view(lot);
    }

    @Override
    @Transactional
    public LotView resume(UUID lotId, String producerId) {
        Lot lot = ownedLot(lotId, producerId, this.lots, this.shows);
        new SectorLots(this.lots.lockBySector(lot.getShowId(), lot.getSectorId())).resume(lotId);
        return view(lot);
    }

    @Override
    @Transactional(readOnly = true)
    public List<SectorAvailability> availability(UUID showId) {
        if (!this.shows.existsById(showId)) {
            throw Problems.notFound("Show");
        }
        Map<UUID, List<Lot>> bySector = this.lots.findByShow(showId).stream()
                .collect(Collectors.groupingBy(Lot::getSectorId));
        return this.sectors.findByShow(showId).stream()
                .map(sector -> describe(sector, bySector.getOrDefault(sector.getId(), List.of())))
                .toList();
    }

    @Override
    @Transactional(readOnly = true)
    public List<SeatAvailability> seats(UUID showId, UUID sectorId) {
        if (!this.sectors.existsById(new Sector.Key(showId, sectorId))) {
            throw Problems.notFound("Setor");
        }
        return this.seats.findBySector(showId, sectorId).stream()
                .map(seat -> new SeatAvailability(seat.getLabel(), seat.isAvailable()))
                .toList();
    }

    @Override
    public void maintain(Instant now) {
        // Nada a fazer: o Postgres é a fonte da verdade.
    }

    /** A disponibilidade de um setor a partir dos lotes dele. O motor Redis usa antes da abertura. */
    static SectorAvailability describe(Sector sector, Collection<Lot> lots) {
        var sectorLots = new SectorLots(List.copyOf(lots));
        SectorLots.Sale sale = sectorLots.sale();
        CurrentLot current = sectorLots.current()
                .filter(lot -> sale == SectorLots.Sale.ON_SALE || sale == SectorLots.Sale.PAUSED)
                .map(lot -> new CurrentLot(lot.getId(), lot.getName(), lot.getPriceCents()))
                .orElse(null);
        int available = sale == SectorLots.Sale.ON_SALE ? sectorLots.current().orElseThrow().getAvailable() : 0;
        return new SectorAvailability(sector.getId(), sector.getName(), sector.getKind(), sector.getCapacity(), sale,
                current, available);
    }

    /** O lote, se o show for deste produtor. Lote de outro produtor é 404, não 403. */
    static Lot ownedLot(UUID lotId, String producerId, LotRepository lots, ShowRepository shows) {
        Lot lot = lots.findById(lotId).orElseThrow(() -> Problems.notFound("Lote"));
        shows.findById(lot.getShowId())
                .filter(show -> show.getProducerId().equals(producerId))
                .orElseThrow(() -> Problems.notFound("Lote"));
        return lot;
    }

    private static LotView view(Lot lot) {
        return new LotView(lot.getId(), lot.getShowId(), lot.getSectorId(), lot.getName(), lot.getPriceCents(),
                lot.getAvailable(), lot.getStatus());
    }
}

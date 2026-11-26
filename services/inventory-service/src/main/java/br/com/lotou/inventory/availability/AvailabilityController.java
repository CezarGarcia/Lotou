package br.com.lotou.inventory.availability;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;

import br.com.lotou.inventory.catalog.Sector;
import br.com.lotou.inventory.catalog.SectorKind;
import br.com.lotou.inventory.catalog.SectorRepository;
import br.com.lotou.inventory.catalog.ShowRepository;
import br.com.lotou.inventory.lot.Lot;
import br.com.lotou.inventory.lot.LotRepository;
import br.com.lotou.inventory.lot.SectorLots;
import br.com.lotou.inventory.seat.SeatRepository;
import br.com.lotou.inventory.shared.problem.Problems;

import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * O que está à venda agora: o lote e o preço de cada setor, quantos ingressos restam e quais
 * cadeiras estão livres. É leitura pública e nunca vem de cache: preço, ingressos restantes e
 * status de assento são sempre os do inventory.
 */
@RestController
@RequestMapping("/v1/availability")
class AvailabilityController {

    record ShowAvailability(UUID showId, List<SectorAvailability> sectors) {
    }

    /**
     * @param sale {@code NOT_OPEN}, {@code ON_SALE}, {@code PAUSED}, {@code SOLD_OUT} ou {@code CLOSED}
     * @param lot o lote em venda, que define o preço; {@code null} se não há lote em venda
     * @param available ingressos que ainda podem ser reservados no lote em venda
     */
    record SectorAvailability(UUID id, String name, SectorKind kind, int capacity, SectorLots.Sale sale,
            CurrentLot lot, int available) {
    }

    record CurrentLot(UUID id, String name, long priceCents) {
    }

    record SectorSeats(UUID showId, UUID sectorId, List<SeatAvailability> seats) {
    }

    /** @param available se a cadeira pode ser reservada agora */
    record SeatAvailability(String label, boolean available) {
    }

    private final ShowRepository shows;
    private final SectorRepository sectors;
    private final LotRepository lots;
    private final SeatRepository seats;

    AvailabilityController(ShowRepository shows, SectorRepository sectors, LotRepository lots,
            SeatRepository seats) {
        this.shows = shows;
        this.sectors = sectors;
        this.lots = lots;
        this.seats = seats;
    }

    @GetMapping("/{showId}")
    @Transactional(readOnly = true)
    ShowAvailability show(@PathVariable UUID showId) {
        if (!this.shows.existsById(showId)) {
            throw Problems.notFound("Show");
        }
        Map<UUID, List<Lot>> lotsBySector = this.lots.findByShow(showId).stream()
                .collect(Collectors.groupingBy(Lot::getSectorId));
        return new ShowAvailability(showId, this.sectors.findByShow(showId).stream()
                .map(sector -> describe(sector, lotsBySector.getOrDefault(sector.getId(), List.of())))
                .toList());
    }

    @GetMapping("/{showId}/sectors/{sectorId}/seats")
    @Transactional(readOnly = true)
    SectorSeats seats(@PathVariable UUID showId, @PathVariable UUID sectorId) {
        if (!this.sectors.existsById(new Sector.Key(showId, sectorId))) {
            throw Problems.notFound("Setor");
        }
        return new SectorSeats(showId, sectorId, this.seats.findBySector(showId, sectorId).stream()
                .map(seat -> new SeatAvailability(seat.getLabel(), seat.isAvailable()))
                .toList());
    }

    private static SectorAvailability describe(Sector sector, Collection<Lot> lots) {
        var sectorLots = new SectorLots(List.copyOf(lots));
        SectorLots.Sale sale = sectorLots.sale();
        CurrentLot current = sectorLots.current()
                .filter(lot -> sale == SectorLots.Sale.ON_SALE || sale == SectorLots.Sale.PAUSED)
                .map(lot -> new CurrentLot(lot.getId(), lot.getName(), lot.getPriceCents()))
                .orElse(null);
        int available = sale == SectorLots.Sale.ON_SALE ? sectorLots.current().orElseThrow().getAvailable() : 0;
        return new SectorAvailability(sector.getId(), sector.getName(), sector.getKind(), sector.getCapacity(),
                sale, current, available);
    }
}

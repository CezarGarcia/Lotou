package br.com.lotou.inventory.availability;

import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.lot.SalesEngine;
import br.com.lotou.inventory.lot.SalesEngine.SeatAvailability;
import br.com.lotou.inventory.lot.SalesEngine.SectorAvailability;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * O que está à venda agora: o lote e o preço de cada setor, quantos ingressos restam e quais
 * cadeiras estão livres. É leitura pública e nunca vem de cache: preço, ingressos restantes e
 * status de assento são sempre os do motor de reserva.
 */
@RestController
@RequestMapping("/v1/availability")
class AvailabilityController {

    record ShowAvailability(UUID showId, List<SectorAvailability> sectors) {
    }

    record SectorSeats(UUID showId, UUID sectorId, List<SeatAvailability> seats) {
    }

    private final SalesEngine engine;

    AvailabilityController(SalesEngine engine) {
        this.engine = engine;
    }

    @GetMapping("/{showId}")
    ShowAvailability show(@PathVariable UUID showId) {
        return new ShowAvailability(showId, this.engine.availability(showId));
    }

    @GetMapping("/{showId}/sectors/{sectorId}/seats")
    SectorSeats seats(@PathVariable UUID showId, @PathVariable UUID sectorId) {
        return new SectorSeats(showId, sectorId, this.engine.seats(showId, sectorId));
    }
}

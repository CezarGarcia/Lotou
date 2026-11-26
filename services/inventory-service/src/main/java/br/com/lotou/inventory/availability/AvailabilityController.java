package br.com.lotou.inventory.availability;

import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.lot.SalesEngine;
import br.com.lotou.inventory.lot.SalesEngine.SeatAvailability;
import br.com.lotou.inventory.lot.SalesEngine.SectorAvailability;
import br.com.lotou.inventory.seatmap.SeatMapEvents;
import br.com.lotou.inventory.shared.problem.Problems;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

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
    private final ObjectProvider<SeatMapEvents> seatMapEvents;

    AvailabilityController(SalesEngine engine, ObjectProvider<SeatMapEvents> seatMapEvents) {
        this.engine = engine;
        this.seatMapEvents = seatMapEvents;
    }

    @GetMapping("/{showId}")
    ShowAvailability show(@PathVariable UUID showId) {
        return new ShowAvailability(showId, this.engine.availability(showId));
    }

    @GetMapping("/{showId}/sectors/{sectorId}/seats")
    SectorSeats seats(@PathVariable UUID showId, @PathVariable UUID sectorId) {
        return new SectorSeats(showId, sectorId, this.engine.seats(showId, sectorId));
    }

    /**
     * O mapa ao vivo: um evento {@code snapshot} com o mapa atual e, depois, um evento
     * {@code seats} a cada cadeira segurada ou solta. Só no motor Redis, que publica as mudanças.
     */
    @GetMapping(path = "/{showId}/sectors/{sectorId}/seats/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    ResponseEntity<SseEmitter> seatEvents(@PathVariable UUID showId, @PathVariable UUID sectorId) {
        SeatMapEvents events = this.seatMapEvents.getIfAvailable();
        if (events == null) {
            throw Problems.notFound("Mapa ao vivo");
        }
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-cache")
                .header("X-Accel-Buffering", "no")
                .body(events.subscribe(showId, sectorId));
    }
}

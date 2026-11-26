package br.com.lotou.inventory.lot;

import java.util.UUID;

import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** O produtor pausa e retoma um lote do seu show. */
@RestController
@RequestMapping("/v1/lots")
class LotController {

    record LotResponse(UUID id, UUID showId, UUID sectorId, String name, long priceCents, int available,
            LotStatus status) {

        static LotResponse of(Lot lot) {
            return new LotResponse(lot.getId(), lot.getShowId(), lot.getSectorId(), lot.getName(),
                    lot.getPriceCents(), lot.getAvailable(), lot.getStatus());
        }
    }

    private final SalesLifecycle lifecycle;

    LotController(SalesLifecycle lifecycle) {
        this.lifecycle = lifecycle;
    }

    @PostMapping("/{id}/pause")
    LotResponse pause(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        return LotResponse.of(this.lifecycle.pause(id, jwt.getSubject()));
    }

    @PostMapping("/{id}/resume")
    LotResponse resume(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        return LotResponse.of(this.lifecycle.resume(id, jwt.getSubject()));
    }
}

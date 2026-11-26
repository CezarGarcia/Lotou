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

    private final SalesEngine engine;

    LotController(SalesEngine engine) {
        this.engine = engine;
    }

    @PostMapping("/{id}/pause")
    SalesEngine.LotView pause(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        return this.engine.pause(id, jwt.getSubject());
    }

    @PostMapping("/{id}/resume")
    SalesEngine.LotView resume(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        return this.engine.resume(id, jwt.getSubject());
    }
}

package br.com.lotou.inventory.reservation;

import java.net.URI;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Pattern;

import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Reservas do comprador. */
@RestController
@RequestMapping("/v1/reservations")
@Validated
class ReservationController {

    static final String IDEMPOTENCY_KEY = "Idempotency-Key";
    static final String REPLAYED = "Idempotent-Replayed";

    private final ReservationService service;

    ReservationController(ReservationService service) {
        this.service = service;
    }

    /**
     * Reserva ingressos e devolve a reserva, com o prazo para pagar. A resposta é síncrona: o
     * comprador sabe na hora se garantiu o ingresso.
     */
    @PostMapping
    ResponseEntity<ReservationResponse> create(@AuthenticationPrincipal Jwt jwt,
            @RequestHeader(IDEMPOTENCY_KEY)
            @Pattern(regexp = "[\\x21-\\x7e]{1,255}", message = "Use de 1 a 255 caracteres ASCII visíveis")
            String idempotencyKey,
            @Valid @RequestBody CreateReservationRequest request) {
        ReservationService.Outcome outcome = this.service.reserve(jwt.getSubject(), idempotencyKey, request);
        var response = ResponseEntity.created(URI.create("/v1/reservations/" + outcome.reservation().getId()));
        if (outcome.replayed()) {
            response.header(REPLAYED, "true");
        }
        return response.body(ReservationResponse.of(outcome.reservation(), outcome.sectorName()));
    }

    @GetMapping("/{id}")
    ReservationResponse get(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        ReservationService.Outcome outcome = this.service.getOwned(id, jwt.getSubject());
        return ReservationResponse.of(outcome.reservation(), outcome.sectorName());
    }
}

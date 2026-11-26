package br.com.lotou.inventory.reservation;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API interna: o order-service lê, confirma e libera reservas. Não passa pelo gateway e exige o
 * papel {@code service}.
 *
 * <p>Na fase 1 estas chamadas são HTTP síncrono. Na fase 3 confirmar e liberar viram os comandos
 * {@code ConfirmReservation} e {@code ReleaseReservation} no Kafka (ADR 23).
 */
@RestController
@RequestMapping("/internal/v1/reservations")
class InternalReservationController {

    /** A reserva com o dono, para o order-service conferir quem está comprando. */
    record InternalReservation(String buyerId, ReservationResponse reservation) {

        static InternalReservation of(ReservationService.Outcome outcome) {
            return new InternalReservation(outcome.reservation().getBuyerId(),
                    ReservationResponse.of(outcome.reservation(), outcome.sectorName()));
        }
    }

    private final ReservationService service;

    InternalReservationController(ReservationService service) {
        this.service = service;
    }

    @GetMapping("/{id}")
    InternalReservation get(@PathVariable UUID id) {
        return InternalReservation.of(this.service.get(id));
    }

    /** Pagamento aprovado. Idempotente: confirmar de novo devolve a mesma reserva. */
    @PostMapping("/{id}/confirm")
    InternalReservation confirm(@PathVariable UUID id) {
        return InternalReservation.of(this.service.confirm(id));
    }

    /** Pagamento recusado: os ingressos voltam à venda. Idempotente. */
    @PostMapping("/{id}/release")
    InternalReservation release(@PathVariable UUID id) {
        return InternalReservation.of(this.service.release(id));
    }
}

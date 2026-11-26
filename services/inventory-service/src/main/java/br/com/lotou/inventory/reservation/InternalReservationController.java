package br.com.lotou.inventory.reservation;

import java.util.UUID;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * API interna: o order-service lê a reserva ao criar o pedido, e quando o prazo de um passo da
 * saga vence. Não passa pelo gateway e exige o papel {@code service}.
 *
 * <p>Confirmar e liberar não estão aqui: desde a fase 3 são os comandos {@code ConfirmReservation}
 * e {@code ReleaseReservation} no Kafka ({@link ReservationCommandListener}).
 */
@RestController
@RequestMapping("/internal/v1/reservations")
class InternalReservationController {

    /** A reserva com o dono, para o order-service conferir quem está comprando. */
    record InternalReservation(String buyerId, ReservationResponse reservation) {

        static InternalReservation of(ReservationService.Outcome outcome) {
            return new InternalReservation(outcome.reservation().buyerId(),
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
}

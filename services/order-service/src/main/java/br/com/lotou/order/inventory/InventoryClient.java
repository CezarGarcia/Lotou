package br.com.lotou.order.inventory;

import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;

import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.security.oauth2.client.web.client.OAuth2ClientHttpRequestInterceptor;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Cliente da API interna de reservas do inventory-service. Cada chamada leva o token da conta de
 * serviço do order-service.
 *
 * <p>Confirmar e liberar são idempotentes do lado do inventory, então o checkout pode repetir uma
 * chamada cujo resultado não chegou.
 */
@Component
public class InventoryClient {

    /** A reserva não está mais segurada: expirou, foi liberada ou já foi confirmada. */
    public static class ReservationNotHeldException extends RuntimeException {

        public ReservationNotHeldException(String detail) {
            super(detail);
        }
    }

    /** O inventory não respondeu ou respondeu com erro: a operação pode ser tentada de novo. */
    public static class InventoryUnavailableException extends RuntimeException {

        public InventoryUnavailableException(Throwable cause) {
            super("inventory-service indisponível: " + cause.getMessage(), cause);
        }
    }

    private static final String NOT_HELD = "urn:lotou:problem:reservation-not-held";

    private final RestClient http;

    public InventoryClient(RestClient.Builder builder, OAuth2ClientHttpRequestInterceptor serviceToken,
            OrderProperties properties) {
        this.http = builder.baseUrl(properties.inventory().baseUrl()).requestInterceptor(serviceToken).build();
    }

    public Optional<ReservationSnapshot> find(UUID reservationId) {
        try {
            return Optional.ofNullable(this.http.get()
                    .uri("/internal/v1/reservations/{id}", reservationId)
                    .retrieve()
                    .body(ReservationSnapshot.class));
        }
        catch (HttpClientErrorException.NotFound ex) {
            return Optional.empty();
        }
        catch (RestClientException ex) {
            throw new InventoryUnavailableException(ex);
        }
    }

    /** Pagamento aprovado: a reserva vira venda. */
    public ReservationSnapshot confirm(UUID reservationId) {
        return change(reservationId, "confirm");
    }

    /** Pagamento recusado: os ingressos voltam à venda. */
    public ReservationSnapshot release(UUID reservationId) {
        return change(reservationId, "release");
    }

    private ReservationSnapshot change(UUID reservationId, String action) {
        try {
            return this.http.post()
                    .uri("/internal/v1/reservations/{id}/{action}", reservationId, action)
                    .retrieve()
                    .body(ReservationSnapshot.class);
        }
        catch (HttpClientErrorException ex) {
            ProblemDetail problem = problemOf(ex);
            if (ex.getStatusCode() == HttpStatus.NOT_FOUND
                    || (problem != null && problem.getType() != null && NOT_HELD.equals(problem.getType().toString()))) {
                throw new ReservationNotHeldException(problem == null ? ex.getMessage() : problem.getDetail());
            }
            throw new InventoryUnavailableException(ex);
        }
        catch (RestClientException ex) {
            throw new InventoryUnavailableException(ex);
        }
    }

    private static ProblemDetail problemOf(HttpClientErrorException ex) {
        try {
            return ex.getResponseBodyAs(ProblemDetail.class);
        }
        catch (RuntimeException unreadable) {
            return null;
        }
    }
}

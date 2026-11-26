package br.com.lotou.order.inventory;

import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;

import org.springframework.security.oauth2.client.web.client.OAuth2ClientHttpRequestInterceptor;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpClientErrorException;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;

/**
 * Cliente da API interna de reservas do inventory-service. Cada chamada leva o token da conta de
 * serviço do order-service.
 *
 * <p>Na fase 3 só a leitura da reserva continua síncrona (o checkout precisa saber na hora se ela
 * vale); confirmar e liberar viraram comandos no Kafka, enviados pela saga de compra.
 */
@Component
public class InventoryClient {

    /** O inventory não respondeu ou respondeu com erro: a operação pode ser tentada de novo. */
    public static class InventoryUnavailableException extends RuntimeException {

        public InventoryUnavailableException(Throwable cause) {
            super("inventory-service indisponível: " + cause.getMessage(), cause);
        }
    }

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

}

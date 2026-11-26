package br.com.lotou.inventory.catalog;

import java.time.Instant;

import br.com.lotou.inventory.config.InventoryProperties;

import org.springframework.security.oauth2.client.web.client.OAuth2ClientHttpRequestInterceptor;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

/** Cliente da API interna de catálogo do event-service. */
@Component
public class CatalogClient {

    private static final int PAGE_SIZE = 100;

    private final RestClient http;

    public CatalogClient(RestClient.Builder builder, OAuth2ClientHttpRequestInterceptor serviceToken,
            InventoryProperties properties) {
        this.http = builder.baseUrl(properties.catalog().baseUrl()).requestInterceptor(serviceToken).build();
    }

    /** Uma página dos shows alterados depois de {@code updatedAfter}, em ordem de alteração. */
    public CatalogShow.Page fetch(Instant updatedAfter, String cursor) {
        return this.http.get()
                .uri(uri -> {
                    uri.path("/internal/v1/catalog/shows").queryParam("limit", PAGE_SIZE);
                    if (updatedAfter != null) {
                        uri.queryParam("updatedAfter", updatedAfter.toString());
                    }
                    if (cursor != null) {
                        uri.queryParam("cursor", cursor);
                    }
                    return uri.build();
                })
                .retrieve()
                .body(CatalogShow.Page.class);
    }
}

package br.com.lotou.order.config;

import java.time.Duration;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/** Configuração do order-service ({@code lotou.order.*}), validada na subida. */
@Validated
@ConfigurationProperties("lotou.order")
public record OrderProperties(
        @NotNull @Valid Inventory inventory,
        @NotNull @Valid Checkout checkout,
        @NotNull @Valid Payment payment,
        @NotNull @Valid Jobs jobs) {

    /** @param baseUrl endereço do inventory-service */
    public record Inventory(@NotBlank String baseUrl) {
    }

    /**
     * @param processingLease por quanto tempo um pedido pendente fica com quem o está processando;
     *     passado esse prazo, o job de recuperação assume
     */
    public record Checkout(@NotNull @DefaultValue("30s") Duration processingLease) {
    }

    /** @param declineRate porcentagem de pagamentos recusados pelo simulador (0 a 100) */
    public record Payment(@Min(0) @Max(100) @DefaultValue("0") int declineRate) {
    }

    /** @param enabled liga os jobs agendados; os testes desligam e chamam os jobs direto */
    public record Jobs(@DefaultValue("true") boolean enabled) {
    }
}

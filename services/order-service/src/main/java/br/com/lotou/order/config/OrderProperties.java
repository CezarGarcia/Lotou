package br.com.lotou.order.config;

import java.time.Duration;

import jakarta.validation.Valid;
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
        @NotNull @Valid Saga saga,
        @NotNull @Valid Jobs jobs) {

    /** @param baseUrl endereço do inventory-service */
    public record Inventory(@NotBlank String baseUrl) {
    }

    /**
     * @param stepTimeout quanto a saga espera a resposta de um passo antes de repetir o comando ou
     *     consultar a reserva; a espera dobra a cada tentativa, até 8 vezes este valor
     * @param maxAttempts a partir de quantas tentativas sem resposta o log vira erro (alerta)
     */
    public record Saga(@NotNull @DefaultValue("15s") Duration stepTimeout, @Min(1) @DefaultValue("5") int maxAttempts) {
    }

    /** @param enabled liga os jobs agendados; os testes desligam e chamam os jobs direto */
    public record Jobs(@DefaultValue("true") boolean enabled) {
    }
}

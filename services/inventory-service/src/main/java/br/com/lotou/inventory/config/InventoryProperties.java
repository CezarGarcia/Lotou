package br.com.lotou.inventory.config;

import java.time.Duration;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/**
 * Configuração do inventory-service ({@code lotou.inventory.*}), validada na subida.
 *
 * @param engine onde a reserva acontece: {@code redis} (padrão) ou {@code postgres} (ADR 3)
 */
@Validated
@ConfigurationProperties("lotou.inventory")
public record InventoryProperties(
        @NotNull @DefaultValue("redis") Engine engine,
        @NotNull @Valid Reservation reservation,
        @NotNull @Valid Catalog catalog,
        @NotNull @Valid Jobs jobs,
        @NotNull @Valid Queue queue) {

    public enum Engine {
        REDIS,
        POSTGRES
    }

    /**
     * @param ttl quanto tempo a reserva segura os ingressos antes de expirar
     * @param maxTicketsPerCpf limite de ingressos por CPF em cada show
     * @param cpfHashKey chave do HMAC que transforma o CPF em hash
     */
    public record Reservation(
            @NotNull @DefaultValue("10m") Duration ttl,
            @Min(1) @Max(4) @DefaultValue("4") int maxTicketsPerCpf,
            @NotBlank String cpfHashKey) {
    }

    /**
     * @param baseUrl endereço do event-service
     * @param overlap quanto a leitura recua a cada rodada, para não perder um show gravado fora de
     *     ordem
     */
    public record Catalog(@NotBlank String baseUrl, @NotNull @DefaultValue("5s") Duration overlap) {
    }

    /** @param enabled liga os jobs agendados; os testes desligam e chamam os jobs direto */
    public record Jobs(@DefaultValue("true") boolean enabled) {
    }

    /**
     * Fila virtual dos shows de alta demanda.
     *
     * @param admissionRate quantos compradores são admitidos por segundo, por show
     * @param admissionTtl quanto tempo vale o token de admissão
     * @param waitingRoomOpensBefore quanto tempo antes da abertura das vendas a sala de espera abre
     */
    public record Queue(
            @Min(1) @DefaultValue("100") int admissionRate,
            @NotNull @DefaultValue("5m") Duration admissionTtl,
            @NotNull @DefaultValue("30m") Duration waitingRoomOpensBefore) {
    }
}

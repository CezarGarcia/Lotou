package br.com.lotou.inventory.reservation;

import java.util.List;
import java.util.UUID;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * Pedido de reserva. Na pista o comprador informa a quantidade; na cadeira numerada, as cadeiras
 * (até 4, tudo ou nada).
 *
 * @param seats rótulos das cadeiras, ex.: {@code ["A-12", "A-13"]}
 * @param cpf CPF do comprador, com ou sem pontuação; vira hash antes de ser gravado
 */
public record CreateReservationRequest(
        @NotNull(message = "Informe o show") UUID showId,
        @NotNull(message = "Informe o setor") UUID sectorId,
        @Min(value = 1, message = "A quantidade mínima é 1")
        @Max(value = 4, message = "O máximo é 4 ingressos por compra") Integer quantity,
        @Size(min = 1, max = 4, message = "Escolha de 1 a 4 cadeiras")
        List<@NotNull @Pattern(regexp = "[A-Z0-9]{1,4}-\\d{1,3}", message = "Cadeira inválida") String> seats,
        @NotBlank(message = "Informe o CPF") String cpf) {

    /** O CPF nunca aparece em log: o registro se descreve sem ele. */
    @Override
    public String toString() {
        return "CreateReservationRequest[showId=%s, sectorId=%s, quantity=%s, seats=%s]".formatted(this.showId,
                this.sectorId, this.quantity, this.seats);
    }
}

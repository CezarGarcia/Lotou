package br.com.lotou.inventory.shared.problem;

import java.util.List;

import org.springframework.http.HttpStatus;

/**
 * Os problemas da venda, iguais nos dois motores de reserva (Postgres e Redis): o cliente recebe o
 * mesmo contrato qualquer que seja o motor.
 */
public final class InventoryProblems {

    private InventoryProblems() {
    }

    public static ProblemException salesNotOpen() {
        return new ProblemException(HttpStatus.CONFLICT, "sales-not-open", "Vendas ainda não abriram",
                "As vendas deste setor ainda não abriram.");
    }

    public static ProblemException salesPaused() {
        return new ProblemException(HttpStatus.CONFLICT, "sales-paused", "Vendas pausadas",
                "As vendas deste setor estão pausadas no momento.");
    }

    public static ProblemException salesClosed() {
        return new ProblemException(HttpStatus.CONFLICT, "sales-closed", "Vendas encerradas",
                "As vendas deste show foram encerradas.");
    }

    public static ProblemException soldOut() {
        return new ProblemException(HttpStatus.CONFLICT, "sold-out", "Ingressos esgotados",
                "Os ingressos deste setor esgotaram.");
    }

    public static ProblemException insufficientStock(int available) {
        return new ProblemException(HttpStatus.CONFLICT, "insufficient-stock", "Ingressos insuficientes",
                "Restam %d ingressos neste lote.".formatted(available)).with("available", available);
    }

    public static ProblemException seatUnavailable(List<String> seats) {
        return new ProblemException(HttpStatus.CONFLICT, "seat-unavailable", "Cadeira ocupada",
                "Uma ou mais cadeiras já foram escolhidas por outra pessoa.").with("seats", seats);
    }

    public static ProblemException seatNotFound(List<String> seats) {
        return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "seat-not-found", "Cadeira inexistente",
                "Uma ou mais cadeiras não existem neste setor.").with("seats", seats);
    }

    public static ProblemException purchaseLimitExceeded(int max, int remaining) {
        return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "purchase-limit-exceeded",
                "Limite de ingressos por CPF",
                "O limite é de %d ingressos por CPF em cada show. Restam %d.".formatted(max, remaining))
                .with("remaining", remaining);
    }

    public static ProblemException idempotencyKeyReused() {
        return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "idempotency-key-reused",
                "Idempotency-Key reutilizada",
                "Esta Idempotency-Key já foi usada com outra reserva. Gere uma chave nova para cada operação.");
    }

    public static ProblemException reservationNotHeld(Object status) {
        return new ProblemException(HttpStatus.CONFLICT, "reservation-not-held", "Reserva não está mais ativa",
                "A reserva está em %s e não pode mais ser alterada.".formatted(status)).with("status", status);
    }

    /** Show de alta demanda: só reserva quem foi admitido pela fila virtual. */
    public static ProblemException queueAdmissionRequired() {
        return new ProblemException(HttpStatus.CONFLICT, "queue-admission-required", "Entre na fila virtual",
                "Este show tem fila virtual: entre na fila e aguarde a sua vez para reservar.");
    }

    /** As vendas abriram, mas o estoque ainda está sendo carregado no Redis. Dura poucos segundos. */
    public static ProblemException inventoryLoading() {
        return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, "inventory-loading", "Abrindo as vendas",
                "As vendas estão abrindo. Tente de novo em instantes.");
    }
}

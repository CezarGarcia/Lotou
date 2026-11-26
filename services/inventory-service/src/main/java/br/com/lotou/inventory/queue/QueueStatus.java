package br.com.lotou.inventory.queue;

import java.time.Instant;
import java.util.UUID;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * Onde o comprador está na fila virtual de um show.
 *
 * @param position posição na fila, 1 é a próxima a ser admitida; só em {@code QUEUED}
 * @param estimatedWaitSeconds estimativa de espera pela taxa de admissão; só em {@code QUEUED}
 * @param admittedUntil até quando vale a admissão; só em {@code ADMITTED}
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record QueueStatus(
        UUID showId,
        State status,
        Long position,
        Long estimatedWaitSeconds,
        Instant admittedUntil,
        Instant salesStartAt,
        Instant waitingRoomOpensAt) {

    public enum State {
        /** O show não é de alta demanda: compra direta, sem fila. */
        NOT_REQUIRED,
        /** A sala de espera ainda não abriu (abre 30 minutos antes das vendas). */
        NOT_OPEN,
        /** Na sala de espera: a posição é sorteada na abertura das vendas. */
        WAITING_ROOM,
        QUEUED,
        /** Pode reservar até {@code admittedUntil}. */
        ADMITTED,
        /** Não está na fila (nunca entrou, ou a admissão venceu e precisa entrar de novo). */
        NOT_IN_QUEUE,
        /** As vendas encerraram. */
        CLOSED
    }

    static QueueStatus of(UUID showId, State state, QueueService.ShowInfo show) {
        return new QueueStatus(showId, state, null, null, null, show.salesStartAt(), show.waitingRoomOpensAt());
    }
}

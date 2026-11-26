package br.com.lotou.inventory.reservation;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.inventory.catalog.Sector;

/**
 * Onde a reserva acontece. Existem dois motores, e o serviço usa um só, escolhido por configuração
 * ({@code lotou.inventory.engine}):
 *
 * <ul>
 *   <li>{@code postgres}: uma transação com {@code SELECT ... FOR UPDATE} (fase 1);
 *   <li>{@code redis}: um script Lua no {@code redis-core}, com o Postgres alimentado por um Redis
 *       Stream (fase 2).
 * </ul>
 *
 * <p>Os dois seguem o mesmo contrato e os mesmos testes; o teste de carga compara os dois (ADR 3).
 */
public interface ReservationEngine {

    /**
     * O que o comprador pediu, já validado e conferido contra o tipo do setor.
     *
     * @param seats rótulos das cadeiras, em ordem e sem repetição; vazio na pista
     */
    record HoldCommand(String buyerId, String idempotencyKey, Sector sector, int quantity, List<String> seats,
            String cpfHash, String requestHash) {
    }

    /** @param replayed se a reserva já existia com a mesma {@code Idempotency-Key} */
    record Held(ReservationView reservation, boolean replayed) {
    }

    /** Segura os ingressos: tudo ou nada. Com a mesma chave de idempotência, devolve a reserva já criada. */
    Held hold(HoldCommand command);

    Optional<ReservationView> find(UUID id);

    /** HELD -> CONFIRMED. Confirmar de novo uma reserva confirmada não muda nada. */
    ReservationView confirm(UUID id);

    /** HELD -> RELEASED: os ingressos voltam à venda. Idempotente. */
    ReservationView release(UUID id);

    /**
     * HELD -> EXPIRED, se o prazo acabou. Se a reserva foi confirmada ou liberada nesse meio tempo,
     * não faz nada.
     *
     * @return se a reserva expirou agora
     */
    boolean expire(UUID id);
}

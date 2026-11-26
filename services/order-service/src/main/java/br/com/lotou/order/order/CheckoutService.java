package br.com.lotou.order.order;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.inventory.InventoryClient;
import br.com.lotou.order.inventory.InventoryClient.InventoryUnavailableException;
import br.com.lotou.order.inventory.ReservationSnapshot;
import br.com.lotou.order.saga.PurchaseSaga;
import br.com.lotou.order.shared.problem.ProblemException;
import br.com.lotou.order.shared.problem.Problems;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * O checkout: cria o pedido a partir da reserva e começa a saga de compra, na mesma transação. A
 * resposta volta na hora com o pedido PENDING; pagamento, confirmação da reserva e emissão dos
 * ingressos seguem pelo Kafka ({@link PurchaseSaga}), e o cliente acompanha pelo {@code GET}.
 *
 * <p>A reserva é lida de forma síncrona (ADR 6): o comprador precisa saber na hora se a reserva
 * ainda vale, e os itens e preços do pedido vêm dela.
 */
@Service
public class CheckoutService {

    /** O resultado de pedir um pedido. */
    public record Outcome(OrderResponse order, boolean replayed) {
    }

    private static final Logger log = LoggerFactory.getLogger(CheckoutService.class);

    private final OrderRepository orders;
    private final InventoryClient inventory;
    private final PurchaseSaga saga;
    private final EntityManager entityManager;
    private final TransactionTemplate transaction;
    private final Clock clock;

    public CheckoutService(OrderRepository orders, InventoryClient inventory, PurchaseSaga saga,
            EntityManager entityManager, PlatformTransactionManager transactionManager, Clock clock) {
        this.orders = orders;
        this.inventory = inventory;
        this.saga = saga;
        this.entityManager = entityManager;
        this.transaction = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    /**
     * Cria o pedido da reserva e começa a saga. Com a mesma {@code Idempotency-Key}, ou para a mesma
     * reserva, devolve o pedido já criado, no estado em que está.
     */
    public Outcome create(String buyerId, String idempotencyKey, UUID reservationId) {
        Optional<Order> sameKey = this.orders.findByBuyerIdAndIdempotencyKey(buyerId, idempotencyKey);
        if (sameKey.isPresent()) {
            if (!sameKey.get().getReservationId().equals(reservationId)) {
                throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "idempotency-key-reused",
                        "Idempotency-Key reutilizada",
                        "Esta Idempotency-Key já foi usada com outra reserva. Gere uma chave nova para cada operação.");
            }
            return new Outcome(describe(sameKey.get().getId()), true);
        }
        Optional<Order> sameReservation = ownedOrderOf(reservationId, buyerId);
        if (sameReservation.isPresent()) {
            return new Outcome(describe(sameReservation.get().getId()), true);
        }

        ReservationSnapshot snapshot = fetchReservation(reservationId, buyerId);
        Instant now = now();
        if (!snapshot.held() || !snapshot.reservation().expiresAt().isAfter(now)) {
            // Pode ser que outro clique tenha criado o pedido enquanto esta requisição lia a reserva:
            // nesse caso a resposta é o pedido que já existe.
            return ownedOrderOf(reservationId, buyerId)
                    .map(winner -> new Outcome(describe(winner.getId()), true))
                    .orElseThrow(() -> new ProblemException(HttpStatus.CONFLICT, "reservation-not-held",
                            "Reserva não está mais ativa",
                            "A reserva expirou ou já foi usada. Reserve os ingressos de novo."));
        }

        try {
            UUID orderId = this.transaction.execute(status -> {
                Order order = Order.pending(buyerId, idempotencyKey, snapshot.reservation(), now);
                this.entityManager.persist(order);
                // Grava o pedido antes da saga: o índice único de reserva decide a corrida aqui. O flush
                // pelo repositório traduz o erro de constraint para DataIntegrityViolationException.
                this.orders.flush();
                this.saga.start(order);
                return order.getId();
            });
            return new Outcome(describe(orderId), false);
        }
        catch (DataIntegrityViolationException ex) {
            // Duas requisições para a mesma reserva chegaram juntas: o índice único deixou uma passar.
            return ownedOrderOf(reservationId, buyerId)
                    .map(winner -> new Outcome(describe(winner.getId()), true))
                    .orElseThrow(() -> ex);
        }
    }

    /** O pedido do comprador. Pedido de outra pessoa é 404, não 403. */
    public OrderResponse getOwned(UUID orderId, String buyerId) {
        return this.transaction.execute(status -> this.orders.findById(orderId)
                .filter(order -> order.getBuyerId().equals(buyerId))
                .map(OrderResponse::of)
                .orElseThrow(() -> Problems.notFound("Pedido")));
    }

    private OrderResponse describe(UUID orderId) {
        return this.transaction.execute(status -> this.orders.findById(orderId).map(OrderResponse::of)
                .orElseThrow(() -> Problems.notFound("Pedido")));
    }

    private Optional<Order> ownedOrderOf(UUID reservationId, String buyerId) {
        return this.orders.findByReservationId(reservationId).filter(order -> order.getBuyerId().equals(buyerId));
    }

    /** A reserva, se for do comprador. Reserva de outra pessoa é 404, não 403. */
    private ReservationSnapshot fetchReservation(UUID reservationId, String buyerId) {
        try {
            return this.inventory.find(reservationId)
                    .filter(snapshot -> snapshot.buyerId().equals(buyerId))
                    .orElseThrow(() -> Problems.notFound("Reserva"));
        }
        catch (InventoryUnavailableException ex) {
            log.warn("Não foi possível ler a reserva {}: {}", reservationId, ex.getMessage());
            throw new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, "upstream-unavailable",
                    "Serviço indisponível", "Não foi possível consultar a reserva. Tente novamente em instantes.");
        }
    }

    private Instant now() {
        // Milissegundos: a mesma precisão que o cliente recebe e que o banco devolve.
        return this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
    }
}

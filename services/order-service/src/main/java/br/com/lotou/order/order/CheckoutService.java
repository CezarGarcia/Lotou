package br.com.lotou.order.order;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;
import br.com.lotou.order.inventory.InventoryClient;
import br.com.lotou.order.inventory.InventoryClient.InventoryUnavailableException;
import br.com.lotou.order.inventory.InventoryClient.ReservationNotHeldException;
import br.com.lotou.order.inventory.ReservationSnapshot;
import br.com.lotou.order.payment.PaymentGateway;
import br.com.lotou.order.shared.problem.ProblemException;
import br.com.lotou.order.shared.problem.Problems;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import jakarta.persistence.EntityManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * O checkout da fase 1: cria o pedido, autoriza o pagamento, confirma a reserva no inventory e
 * emite os ingressos. Se o pagamento é recusado, libera a reserva e cancela o pedido.
 *
 * <p>Os passos conversam com outros serviços, então não cabem numa transação só. Em vez disso:
 *
 * <ul>
 *   <li>cada passo grava o que decidiu antes do passo seguinte (o resultado do pagamento, por
 *       exemplo), em transações curtas;
 *   <li>cada passo é idempotente, do lado de cá e do lado do inventory;
 *   <li>{@link #process} pode ser chamado de novo a qualquer momento e continua de onde parou. É o
 *       que o {@link OrderRecoveryJob} faz com um pedido que ficou pendente depois de uma queda.
 * </ul>
 *
 * <p>Na fase 3 esta orquestração vira a saga de compra, com os mesmos passos trafegando pelo
 * Kafka (ADR 23).
 */
@Service
public class CheckoutService {

    /** O resultado de pedir um pedido. */
    public record Outcome(OrderResponse order, boolean replayed) {
    }

    private static final Logger log = LoggerFactory.getLogger(CheckoutService.class);
    private static final AttributeKey<String> STATUS = AttributeKey.stringKey("status");

    private final OrderRepository orders;
    private final InventoryClient inventory;
    private final PaymentGateway payments;
    private final EntityManager entityManager;
    private final TransactionTemplate transaction;
    private final OrderProperties properties;
    private final Clock clock;
    private final LongCounter ordersTotal;

    public CheckoutService(OrderRepository orders, InventoryClient inventory, PaymentGateway payments,
            EntityManager entityManager, PlatformTransactionManager transactionManager, OrderProperties properties,
            Clock clock) {
        this.orders = orders;
        this.inventory = inventory;
        this.payments = payments;
        this.entityManager = entityManager;
        this.transaction = new TransactionTemplate(transactionManager);
        this.properties = properties;
        this.clock = clock;
        this.ordersTotal = GlobalOpenTelemetry.getMeter("lotou.order").counterBuilder("orders_total")
                .setDescription("Pedidos que chegaram a um estado final, por estado")
                .build();
    }

    /**
     * Cria o pedido da reserva e tenta concluí-lo. Devolve o pedido no estado em que ficou:
     * CONFIRMED, CANCELLED ou, se o inventory não respondeu, PENDING (o job conclui depois).
     *
     * <p>Com a mesma {@code Idempotency-Key}, ou para a mesma reserva, devolve o pedido já criado.
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
            // Pode ser que outro clique tenha criado e concluído o pedido enquanto esta requisição
            // lia a reserva: nesse caso a resposta é o pedido que já existe.
            return ownedOrderOf(reservationId, buyerId)
                    .map(winner -> new Outcome(describe(winner.getId()), true))
                    .orElseThrow(() -> new ProblemException(HttpStatus.CONFLICT, "reservation-not-held",
                            "Reserva não está mais ativa",
                            "A reserva expirou ou já foi usada. Reserve os ingressos de novo."));
        }

        UUID orderId;
        try {
            orderId = this.transaction.execute(status -> {
                Order order = Order.pending(buyerId, idempotencyKey, snapshot.reservation(), now,
                        now.plus(this.properties.checkout().processingLease()));
                this.entityManager.persist(order);
                return order.getId();
            });
        }
        catch (DataIntegrityViolationException ex) {
            // Duas requisições para a mesma reserva chegaram juntas: o índice único deixou uma passar.
            return ownedOrderOf(reservationId, buyerId)
                    .map(winner -> new Outcome(describe(winner.getId()), true))
                    .orElseThrow(() -> ex);
        }

        try {
            process(orderId);
        }
        catch (InventoryUnavailableException ex) {
            // O pedido existe e fica PENDING; o job de recuperação conclui quando o inventory voltar.
            log.warn("Pedido {} ficou pendente: {}", orderId, ex.getMessage());
        }
        return new Outcome(describe(orderId), false);
    }

    /**
     * Leva um pedido pendente até o fim. Pode ser chamado mais de uma vez: cada passo confere o
     * que já foi feito antes de agir.
     */
    public void process(UUID orderId) {
        Order order = this.orders.findById(orderId).orElseThrow(() -> Problems.notFound("Pedido"));
        if (!order.is(OrderStatus.PENDING)) {
            return;
        }
        UUID reservationId = order.getReservationId();

        // 1. Pagamento. O resultado é gravado antes de seguir: retomar o pedido não cobra de novo.
        PaymentGateway.Result payment = order.getPaymentStatus();
        if (payment == null) {
            payment = this.payments.authorize(orderId, order.getTotalCents());
            PaymentGateway.Result decided = payment;
            update(orderId, pending -> pending.recordPayment(decided, now()));
        }

        // 2a. Recusado: compensação. Os ingressos voltam à venda e o pedido é cancelado.
        if (payment == PaymentGateway.Result.DECLINED) {
            try {
                this.inventory.release(reservationId);
            }
            catch (ReservationNotHeldException alreadyGone) {
                // A reserva já tinha expirado: os ingressos já voltaram à venda.
            }
            cancel(orderId, CancelReason.PAYMENT_DECLINED);
            return;
        }

        // 2b. Aprovado: a reserva vira venda no inventory.
        try {
            this.inventory.confirm(reservationId);
        }
        catch (ReservationNotHeldException expired) {
            this.payments.voidAuthorization(orderId);
            cancel(orderId, CancelReason.RESERVATION_EXPIRED);
            return;
        }

        // 3. Pedido confirmado e ingressos emitidos, na mesma transação.
        try {
            update(orderId, pending -> pending.confirm(now()));
            this.ordersTotal.add(1, Attributes.of(STATUS, OrderStatus.CONFIRMED.name()));
        }
        catch (DataIntegrityViolationException conflict) {
            // A última defesa disparou: o banco recusou um segundo ingresso para a mesma cadeira.
            log.error("Venda dupla barrada pela constraint de ingressos: pedido {} reserva {}", orderId,
                    reservationId, conflict);
            this.payments.voidAuthorization(orderId);
            cancel(orderId, CancelReason.TICKET_CONFLICT);
        }
    }

    /** O pedido do comprador. Pedido de outra pessoa é 404, não 403. */
    public OrderResponse getOwned(UUID orderId, String buyerId) {
        return this.transaction.execute(status -> this.orders.findById(orderId)
                .filter(order -> order.getBuyerId().equals(buyerId))
                .map(OrderResponse::of)
                .orElseThrow(() -> Problems.notFound("Pedido")));
    }

    private void cancel(UUID orderId, CancelReason reason) {
        update(orderId, pending -> pending.cancel(reason, now()));
        this.ordersTotal.add(1, Attributes.of(STATUS, OrderStatus.CANCELLED.name()));
    }

    /** Aplica a mudança com o pedido travado, só se ele ainda estiver pendente. */
    private void update(UUID orderId, java.util.function.Consumer<Order> change) {
        this.transaction.executeWithoutResult(status -> {
            Order order = this.orders.lockById(orderId).orElseThrow(() -> Problems.notFound("Pedido"));
            if (order.is(OrderStatus.PENDING)) {
                change.accept(order);
                // Grava agora, pelo repositório: um erro de constraint aparece aqui, já traduzido
                // para DataIntegrityViolationException.
                this.orders.flush();
            }
        });
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

package br.com.lotou.order.refund;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.catalog.LocalShow;
import br.com.lotou.order.catalog.ShowCatalog;
import br.com.lotou.order.config.OrderProperties;
import br.com.lotou.order.coupon.CouponRepository;
import br.com.lotou.order.messaging.Envelope;
import br.com.lotou.order.messaging.Inbox;
import br.com.lotou.order.messaging.MalformedMessageException;
import br.com.lotou.order.messaging.Outbox;
import br.com.lotou.order.messaging.Topics;
import br.com.lotou.order.order.Order;
import br.com.lotou.order.order.OrderRepository;
import br.com.lotou.order.order.OrderStatus;
import br.com.lotou.order.shared.problem.ProblemException;
import br.com.lotou.order.shared.problem.Problems;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * A saga de reembolso de um pedido confirmado: cancela os ingressos, estorna o pagamento e, se foi
 * o comprador quem cancelou, devolve os ingressos à venda. Orquestrada como a de compra (ADR 7):
 * cada passo grava o estado em {@code refunds} e os comandos no outbox, na mesma transação.
 *
 * <pre>
 * (show cancelado) QUEUED ──vez──> REFUNDING ──PaymentRefunded──> COMPLETED
 *                                    │   ^
 *                    5 RefundFailed  v   │ produtor reprocessa
 *                                   FAILED
 * </pre>
 *
 * <p>O cancelamento pelo comprador começa direto em REFUNDING. O cupom usado volta a ter o uso
 * quando o estorno é concluído.
 */
@Service
public class RefundService {

    private static final Logger log = LoggerFactory.getLogger(RefundService.class);
    private static final AttributeKey<String> REASON = AttributeKey.stringKey("reason");
    private static final AttributeKey<String> OUTCOME = AttributeKey.stringKey("outcome");

    private final RefundRepository refunds;
    private final OrderRepository orders;
    private final ShowCatalog catalog;
    private final CouponRepository coupons;
    private final Outbox outbox;
    private final Inbox inbox;
    private final JsonMapper json;
    private final Clock clock;
    private final OrderProperties.Refunds settings;
    private final OrderProperties.Saga saga;
    private final LongCounter refundsTotal;

    public RefundService(RefundRepository refunds, OrderRepository orders, ShowCatalog catalog,
            CouponRepository coupons, Outbox outbox, Inbox inbox, JsonMapper json, Clock clock,
            OrderProperties properties) {
        this.refunds = refunds;
        this.orders = orders;
        this.catalog = catalog;
        this.coupons = coupons;
        this.outbox = outbox;
        this.inbox = inbox;
        this.json = json;
        this.clock = clock;
        this.settings = properties.refunds();
        this.saga = properties.saga();
        this.refundsTotal = GlobalOpenTelemetry.getMeter("lotou.order").counterBuilder("refunds_total")
                .setDescription("Reembolsos que chegaram a um estado final, por motivo e resultado")
                .build();
    }

    // ------------------------------------------------------------- comprador

    /**
     * O comprador cancela o pedido inteiro. Repetir é seguro: um pedido já em reembolso volta como
     * está.
     */
    @Transactional
    public Order cancelByBuyer(UUID orderId, String buyerId) {
        Order order = this.orders.lockById(orderId).filter(found -> found.getBuyerId().equals(buyerId))
                .orElseThrow(() -> Problems.notFound("Pedido"));
        if (order.is(OrderStatus.REFUNDING) || order.is(OrderStatus.REFUNDED)) {
            return order;
        }
        LocalShow show = this.catalog.find(order.getShowId()).orElse(null);
        CancellationPolicy.Decision decision = CancellationPolicy.decide(order, show, now());
        if (!decision.allowed()) {
            throw new ProblemException(HttpStatus.CONFLICT, "cancellation-not-allowed", "Cancelamento não permitido",
                    describe(decision.reason())).with("reason", decision.reason().name());
        }
        // Show cancelado: o reembolso já viria pela fila; o comprador só passa na frente.
        Refund.Reason reason = show != null && show.isCancelled() ? Refund.Reason.SHOW_CANCELLED
                : Refund.Reason.ORDER_CANCELLED;
        Optional<Refund> queued = this.refunds.lock(orderId);
        if (queued.isPresent()) {
            startQueued(order, queued.get());
        }
        else {
            Instant now = now();
            this.refunds.insert(orderId, reason, Refund.Status.REFUNDING, order.getTotalCents(), deadline(now, 1), now);
            begin(order, reason);
        }
        return order;
    }

    // --------------------------------------------------------------- produtor

    /** O produtor manda tentar de novo um estorno que falhou. Repetir é seguro. */
    @Transactional
    public Order retry(UUID orderId, String producerId) {
        Order order = this.orders.lockById(orderId).orElseThrow(() -> Problems.notFound("Pedido"));
        ownedShow(order.getShowId(), producerId);
        if (order.is(OrderStatus.REFUNDING)) {
            return order;
        }
        Refund refund = this.refunds.lock(orderId).filter(found -> found.status() == Refund.Status.FAILED)
                .orElseThrow(() -> Problems.invalidTransition("Um pedido", order.getStatus(), OrderStatus.REFUNDING));
        Instant now = now();
        order.startRefund(now);
        this.refunds.update(orderId, Refund.Status.REFUNDING, 0, deadline(now, 1), now);
        refundPayment(order, refund.reason());
        log.info("Estorno do pedido {} reprocessado pelo produtor", orderId);
        return order;
    }

    /** Pedidos do show com estorno que falhou, para o produtor tratar. */
    @Transactional(readOnly = true)
    public List<Order> failed(UUID showId, String producerId) {
        ownedShow(showId, producerId);
        return this.orders.findByShowIdAndStatusOrderById(showId, OrderStatus.REFUND_FAILED);
    }

    // ----------------------------------------------------- show cancelado e fila

    /** Põe na fila os pedidos confirmados de shows cancelados que ainda não têm reembolso. */
    @Transactional(propagation = Propagation.MANDATORY)
    public int queueCancelledShow(UUID showId) {
        int queued = this.refunds.queueCancelledShows(showId, now());
        if (queued > 0) {
            log.info("Show {} cancelado: {} pedidos na fila de reembolso", showId, queued);
        }
        return queued;
    }

    /** Começa o reembolso de um pedido da fila, se ele ainda estiver lá. */
    @Transactional
    public boolean startQueued(UUID orderId) {
        Optional<Refund> refund = this.refunds.lock(orderId).filter(found -> found.status() == Refund.Status.QUEUED);
        if (refund.isEmpty()) {
            return false;
        }
        Order order = this.orders.lockById(orderId).orElseThrow();
        startQueued(order, refund.get());
        return true;
    }

    private void startQueued(Order order, Refund refund) {
        if (refund.status() != Refund.Status.QUEUED) {
            return;
        }
        if (!order.is(OrderStatus.CONFIRMED)) {
            // O pedido mudou de estado desde que entrou na fila (o comprador cancelou antes): nada a fazer.
            log.warn("Reembolso na fila do pedido {} em {}: ignorado", order.getId(), order.getStatus());
            return;
        }
        Instant now = now();
        this.refunds.update(order.getId(), Refund.Status.REFUNDING, 0, deadline(now, 1), now);
        begin(order, refund.reason());
    }

    // ----------------------------------------------------------- respostas

    /** Se o pedido tem reembolso: as respostas do payment-mock sobre ele são desta saga. */
    public boolean owns(UUID orderId) {
        return this.refunds.exists(orderId);
    }

    /** PaymentRefunded ou RefundFailed de um pedido em reembolso. Devolve se mudou algo. */
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean handle(String topic, Envelope message) {
        UUID orderId = read(message).orderId();
        Optional<Refund> found = this.refunds.lock(orderId);
        if (found.isEmpty() || !this.inbox.firstTime(topic, message)) {
            return false;
        }
        Refund refund = found.get();
        if (refund.status() != Refund.Status.REFUNDING) {
            return false; // Resposta repetida ou atrasada: o reembolso já terminou.
        }
        Order order = this.orders.lockById(orderId).orElseThrow();
        Instant now = now();
        if ("PaymentRefunded".equals(message.type())) {
            order.refunded(now);
            this.refunds.update(orderId, Refund.Status.COMPLETED, refund.failures(), null, now);
            this.coupons.giveBack(orderId, now);
            this.outbox.enqueue(Topics.ORDER_EVENTS, key(order), "OrderRefunded",
                    new RefundMessages.OrderRefunded(order.getId(), order.getBuyerId(), order.getShowId(),
                            order.getReservationId(), order.getRefundedCents(), refund.reason().name(), now,
                            order.getSubtotalCents(), order.getDiscountCents(), order.getServiceFeeCents(),
                            order.getServiceFeePaidBy(), order.getCouponId(), order.getCouponCode()));
            this.refundsTotal.add(1, Attributes.of(REASON, refund.reason().name(), OUTCOME, "refunded"));
            return true;
        }
        int failures = refund.failures() + 1;
        if (failures >= this.settings.maxFailures()) {
            order.refundFailed(now);
            this.refunds.update(orderId, Refund.Status.FAILED, failures, null, now);
            this.outbox.enqueue(Topics.ORDER_EVENTS, key(order), "OrderRefundFailed",
                    new RefundMessages.OrderRefundFailed(order.getId(), order.getBuyerId(), order.getShowId(),
                            failures, now));
            this.refundsTotal.add(1, Attributes.of(REASON, refund.reason().name(), OUTCOME, "failed"));
            log.error("Estorno do pedido {} falhou {} vezes: tratamento manual", orderId, failures);
        }
        else {
            // Tenta de novo quando o prazo vencer, com espera crescente.
            this.refunds.update(orderId, Refund.Status.REFUNDING, failures, deadline(now, failures + 1), now);
            log.warn("Estorno do pedido {} falhou (falha {}); nova tentativa quando o prazo vencer", orderId,
                    failures);
        }
        return true;
    }

    /** O prazo do estorno venceu sem resposta (ou depois de uma falha): pede de novo. */
    @Transactional
    public void onDeadline(UUID orderId) {
        Optional<Refund> found = this.refunds.lock(orderId);
        Instant now = now();
        if (found.isEmpty() || found.get().status() != Refund.Status.REFUNDING || found.get().deadline() == null
                || found.get().deadline().isAfter(now)) {
            return;
        }
        Refund refund = found.get();
        Order order = this.orders.lockById(orderId).orElseThrow();
        this.refunds.update(orderId, Refund.Status.REFUNDING, refund.failures(),
                deadline(now, refund.failures() + 2), now);
        refundPayment(order, refund.reason());
    }

    List<UUID> queued(int limit) {
        return this.refunds.queued(limit);
    }

    List<UUID> overdue(int limit) {
        return this.refunds.overdue(now(), limit);
    }

    @Transactional
    public int queueAllCancelledShows() {
        return this.refunds.queueCancelledShows(null, now());
    }

    // ------------------------------------------------------------------ apoio

    /** Ingressos cancelados, estorno pedido e, se o comprador cancelou, ingressos de volta à venda. */
    private void begin(Order order, Refund.Reason reason) {
        Instant now = now();
        List<UUID> cancelled = order.startRefund(now);
        String key = key(order);
        if (!cancelled.isEmpty()) {
            this.outbox.enqueue(Topics.ORDER_EVENTS, key, "TicketsCancelled",
                    new RefundMessages.TicketsCancelled(order.getId(), order.getBuyerId(), order.getShowId(),
                            cancelled, reason.name(), now));
        }
        refundPayment(order, reason);
        if (reason == Refund.Reason.ORDER_CANCELLED) {
            this.outbox.enqueue(Topics.INVENTORY_COMMANDS, key, "ReturnTickets",
                    new RefundMessages.ReturnTickets(order.getId(), order.getReservationId(), reason.name()));
        }
        log.info("Reembolso do pedido {} começou ({})", order.getId(), reason);
    }

    private void refundPayment(Order order, Refund.Reason reason) {
        this.outbox.enqueue(Topics.PAYMENT_COMMANDS, key(order), "RefundPayment",
                new RefundMessages.RefundPayment(order.getId(), order.getTotalCents(), reason.name()));
    }

    private LocalShow ownedShow(UUID showId, String producerId) {
        return this.catalog.find(showId).filter(show -> show.producerId().equals(producerId))
                .orElseThrow(() -> Problems.notFound("Show"));
    }

    private static String describe(CancellationPolicy.Refusal reason) {
        return switch (reason) {
            case NOT_CONFIRMED -> "Só um pedido confirmado pode ser cancelado.";
            case WINDOW_EXPIRED -> "O prazo de 7 dias depois da compra para cancelar já passou.";
            case TOO_CLOSE_TO_SHOW -> "Faltam menos de 48 horas para o show; o cancelamento não é mais possível.";
            case TICKET_USED -> "Um dos ingressos já foi usado na portaria.";
        };
    }

    /** Prazo do passo, com espera dobrando a cada tentativa até 8 vezes o prazo base. */
    private Instant deadline(Instant now, int attempt) {
        long factor = 1L << Math.min(attempt - 1, 3);
        return now.plus(this.saga.stepTimeout().multipliedBy(factor));
    }

    private RefundMessages.PaymentAnswer read(Envelope message) {
        try {
            RefundMessages.PaymentAnswer answer = this.json.treeToValue(message.payload(),
                    RefundMessages.PaymentAnswer.class);
            if (answer == null || answer.orderId() == null) {
                throw new MalformedMessageException(message.type() + " sem orderId");
            }
            return answer;
        }
        catch (IllegalArgumentException | tools.jackson.core.JacksonException ex) {
            throw new MalformedMessageException(message.type() + " fora do contrato: " + ex.getMessage());
        }
    }

    private static String key(Order order) {
        return order.getId().toString();
    }

    private Instant now() {
        return this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
    }
}

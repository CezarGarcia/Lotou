package br.com.lotou.order.saga;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;
import br.com.lotou.order.messaging.Envelope;
import br.com.lotou.order.messaging.Inbox;
import br.com.lotou.order.messaging.MalformedMessageException;
import br.com.lotou.order.messaging.Outbox;
import br.com.lotou.order.messaging.Topics;
import br.com.lotou.order.order.CancelReason;
import br.com.lotou.order.order.Order;
import br.com.lotou.order.order.OrderItem;
import br.com.lotou.order.order.OrderRepository;
import br.com.lotou.order.order.OrderStatus;
import br.com.lotou.order.order.PaymentStatus;
import br.com.lotou.order.order.TicketCodes;
import br.com.lotou.order.order.TicketRepository;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.LongCounter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * A saga de compra, orquestrada pelo order-service (ADR 7). Cada passo envia um comando pelo
 * outbox e espera a resposta no Kafka; o passo atual fica em {@code saga_state}.
 *
 * <p>Toda mudança acontece numa transação só: o passo novo, o pedido, os comandos e eventos no
 * outbox e o registro da mensagem processada. Uma resposta repetida, ou que chega fora do passo
 * em que faria sentido, não muda nada.
 *
 * <p>As respostas do inventory são fatos sobre a reserva (confirmada, liberada, expirada), não
 * respostas a um comando: a saga reage a elas em qualquer passo. Se um fato não chega (por exemplo,
 * a reserva expirou antes de o pedido existir), o {@link SagaDeadlineJob} consulta a reserva quando
 * o prazo do passo vence.
 */
@Service
public class PurchaseSaga {

    private static final Logger log = LoggerFactory.getLogger(PurchaseSaga.class);
    private static final AttributeKey<String> STATUS = AttributeKey.stringKey("status");
    private static final AttributeKey<String> OUTCOME = AttributeKey.stringKey("outcome");
    private static final AttributeKey<String> SAGA = AttributeKey.stringKey("saga");

    private final SagaStateRepository sagas;
    private final OrderRepository orders;
    private final TicketRepository tickets;
    private final TicketCodes ticketCodes;
    private final Outbox outbox;
    private final Inbox inbox;
    private final JsonMapper json;
    private final Clock clock;
    private final OrderProperties.Saga settings;
    private final LongCounter ordersTotal;
    private final DoubleHistogram sagaDuration;

    public PurchaseSaga(SagaStateRepository sagas, OrderRepository orders, TicketRepository tickets,
            TicketCodes ticketCodes, Outbox outbox, Inbox inbox, JsonMapper json, Clock clock,
            OrderProperties properties) {
        this.sagas = sagas;
        this.orders = orders;
        this.tickets = tickets;
        this.ticketCodes = ticketCodes;
        this.outbox = outbox;
        this.inbox = inbox;
        this.json = json;
        this.clock = clock;
        this.settings = properties.saga();
        var meter = GlobalOpenTelemetry.getMeter("lotou.order");
        this.ordersTotal = meter.counterBuilder("orders_total")
                .setDescription("Pedidos que chegaram a um estado final, por estado")
                .build();
        this.sagaDuration = meter.histogramBuilder("saga_duration_seconds")
                .setDescription("Do pedido criado ao fim da saga, por saga e resultado")
                .setUnit("s")
                .build();
    }

    // ------------------------------------------------------------------- início

    /** Começa a saga de um pedido recém-criado, na transação que o criou. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void start(Order order) {
        Instant now = now();
        this.sagas.save(SagaState.purchase(order.getId(), now, deadline(now, 1)));
        this.outbox.enqueue(Topics.ORDER_EVENTS, key(order), "OrderCreated",
                new Messages.OrderCreated(order.getId(), order.getBuyerId(), order.getShowId(), order.getReservationId(),
                        order.getTotalCents(), items(order), order.getCreatedAt()));
        authorizePayment(order);
    }

    // --------------------------------------------------------------- respostas

    /**
     * Trata uma mensagem de {@code payment.events} ou {@code inventory.events}. Devolve se ela
     * mudou alguma coisa (para log e testes).
     */
    @Transactional
    public boolean handle(String topic, Envelope message) {
        return switch (message.type()) {
            case "PaymentAuthorized", "PaymentDeclined", "PaymentRefunded", "RefundFailed" ->
                    onPayment(topic, message, read(message, Messages.PaymentAnswer.class).orderId());
            case "ReservationConfirmed", "ReservationReleased" -> onReservation(topic, message,
                    read(message, Messages.ReservationFact.class));
            default -> false; // LotSoldOut, LotOpened e tipos novos não interessam à saga.
        };
    }

    private boolean onPayment(String topic, Envelope message, UUID orderId) {
        Optional<SagaState> found = this.sagas.lockByOrderId(orderId);
        if (found.isEmpty() || !this.inbox.firstTime(topic, message)) {
            return false;
        }
        SagaState saga = found.get();
        Order order = this.orders.lockById(orderId).orElseThrow();
        return switch (message.type()) {
            case "PaymentAuthorized" -> paymentAuthorized(saga, order);
            case "PaymentDeclined" -> paymentDeclined(saga, order);
            case "PaymentRefunded" -> paymentRefunded(saga, order);
            default -> refundFailed(saga, order);
        };
    }

    private boolean onReservation(String topic, Envelope message, Messages.ReservationFact fact) {
        // O inventory publica os fatos de todas as reservas; só interessam as que viraram pedido.
        Optional<Order> owner = this.orders.findByReservationId(fact.reservationId());
        if (owner.isEmpty()) {
            return false;
        }
        Optional<SagaState> found = this.sagas.lockByOrderId(owner.get().getId());
        if (found.isEmpty() || !this.inbox.firstTime(topic, message)) {
            return false;
        }
        Order order = this.orders.lockById(owner.get().getId()).orElseThrow();
        return "ReservationConfirmed".equals(message.type()) ? reservationConfirmed(found.get(), order)
                : reservationReleased(found.get(), order);
    }

    private boolean paymentAuthorized(SagaState saga, Order order) {
        if (!saga.is(SagaStep.AUTHORIZING_PAYMENT)) {
            return false;
        }
        order.recordPayment(PaymentStatus.AUTHORIZED, now());
        if (saga.isReservationLost()) {
            // Aprovado, mas os ingressos já voltaram à venda: devolve o dinheiro.
            refund(saga, order, CancelReason.RESERVATION_EXPIRED);
        }
        else {
            saga.moveTo(SagaStep.CONFIRMING_RESERVATION, now(), deadline(now(), 1));
            confirmReservation(order);
        }
        return true;
    }

    private boolean paymentDeclined(SagaState saga, Order order) {
        if (!saga.is(SagaStep.AUTHORIZING_PAYMENT)) {
            return false;
        }
        order.recordPayment(PaymentStatus.DECLINED, now());
        if (saga.isReservationLost()) {
            // Os ingressos já voltaram à venda sozinhos: não há o que liberar.
            cancel(saga, order, CancelReason.PAYMENT_DECLINED);
        }
        else {
            saga.moveTo(SagaStep.RELEASING_RESERVATION, now(), deadline(now(), 1));
            releaseReservation(order);
        }
        return true;
    }

    private boolean paymentRefunded(SagaState saga, Order order) {
        if (!saga.is(SagaStep.REFUNDING_PAYMENT)) {
            return false;
        }
        order.recordPayment(PaymentStatus.REFUNDED, now());
        cancel(saga, order, saga.getCancelReason());
        return true;
    }

    private boolean refundFailed(SagaState saga, Order order) {
        if (!saga.is(SagaStep.REFUNDING_PAYMENT)) {
            return false;
        }
        // O estorno é tentado de novo quando o prazo vencer, com espera crescente.
        log.warn("Estorno do pedido {} falhou (tentativa {}); nova tentativa quando o prazo vencer", order.getId(),
                saga.getAttempts());
        return false;
    }

    private boolean reservationConfirmed(SagaState saga, Order order) {
        if (!saga.is(SagaStep.CONFIRMING_RESERVATION)) {
            return false;
        }
        if (seatAlreadySold(order)) {
            // A última defesa (ADR 4): outra compra já tem ingresso ativo para uma destas cadeiras.
            log.error("Venda dupla barrada antes de emitir ingressos: pedido {} reserva {}", order.getId(),
                    order.getReservationId());
            refund(saga, order, CancelReason.TICKET_CONFLICT);
            return true;
        }
        Instant now = now();
        order.confirm(now, this.ticketCodes);
        // Grava agora: se a constraint de ingressos disparar numa corrida, a transação inteira volta
        // e a mensagem é processada de novo, quando a checagem acima já enxerga o outro ingresso.
        this.orders.flush();
        saga.moveTo(SagaStep.COMPLETED, now, null);
        String key = key(order);
        this.outbox.enqueue(Topics.ORDER_EVENTS, key, "OrderConfirmed",
                new Messages.OrderConfirmed(order.getId(), order.getBuyerId(), order.getShowId(),
                        order.getReservationId(), order.getTotalCents(), items(order), now));
        this.outbox.enqueue(Topics.ORDER_EVENTS, key, "TicketsIssued",
                new Messages.TicketsIssued(order.getId(), order.getBuyerId(), order.getShowId(),
                        order.getTickets().stream()
                                .map(ticket -> new Messages.IssuedTicket(ticket.getId(), ticket.getSectorId(),
                                        ticket.getSectorName(), ticket.getSeatLabel(), ticket.getCode()))
                                .toList(),
                        now));
        finished(saga, OrderStatus.CONFIRMED, "completed");
        return true;
    }

    private boolean reservationReleased(SagaState saga, Order order) {
        return switch (saga.getStep()) {
            case RELEASING_RESERVATION -> {
                cancel(saga, order, CancelReason.PAYMENT_DECLINED);
                yield true;
            }
            case AUTHORIZING_PAYMENT -> {
                // Expirou enquanto o pagamento era autorizado: decide quando a resposta chegar.
                saga.markReservationLost(now());
                yield true;
            }
            case CONFIRMING_RESERVATION -> {
                // Pago, mas a reserva expirou antes de ser confirmada: estorna.
                refund(saga, order, CancelReason.RESERVATION_EXPIRED);
                yield true;
            }
            default -> false;
        };
    }

    // ------------------------------------------------------------ prazos vencidos

    /** O que o inventory diz da reserva, consultado quando o prazo de um passo vence. */
    public enum ReservationState {
        HELD, CONFIRMED, RELEASED, UNKNOWN
    }

    /**
     * O prazo do passo atual venceu sem resposta. Repete o comando ou, quando a resposta esperada é
     * um fato sobre a reserva, age pelo estado da reserva que o job consultou.
     */
    @Transactional
    public void onDeadline(UUID orderId, ReservationState reservation) {
        SagaState saga = this.sagas.lockByOrderId(orderId).orElse(null);
        Instant now = now();
        if (saga == null || saga.getStep().isFinal() || saga.getDeadline() == null
                || saga.getDeadline().isAfter(now)) {
            return; // Outra instância já tratou, ou a resposta chegou nesse meio tempo.
        }
        Order order = this.orders.lockById(orderId).orElseThrow();
        switch (saga.getStep()) {
            case AUTHORIZING_PAYMENT -> {
                retry(saga);
                authorizePayment(order);
            }
            case REFUNDING_PAYMENT -> {
                retry(saga);
                refundPayment(order, saga.getCancelReason());
            }
            case CONFIRMING_RESERVATION -> {
                switch (reservation) {
                    case CONFIRMED -> reservationConfirmed(saga, order);
                    case RELEASED -> reservationReleased(saga, order);
                    default -> {
                        retry(saga);
                        confirmReservation(order);
                    }
                }
            }
            case RELEASING_RESERVATION -> {
                if (reservation == ReservationState.RELEASED) {
                    reservationReleased(saga, order);
                }
                else {
                    retry(saga);
                    releaseReservation(order);
                }
            }
            default -> {
            }
        }
    }

    /** Se, para decidir, o job precisa consultar a reserva no inventory. */
    public static boolean needsReservationState(SagaStep step) {
        return step == SagaStep.CONFIRMING_RESERVATION || step == SagaStep.RELEASING_RESERVATION;
    }

    // ------------------------------------------------------------------ comandos

    private void authorizePayment(Order order) {
        this.outbox.enqueue(Topics.PAYMENT_COMMANDS, key(order), "AuthorizePayment",
                new Messages.AuthorizePayment(order.getId(), order.getBuyerId(), order.getTotalCents()));
    }

    private void confirmReservation(Order order) {
        this.outbox.enqueue(Topics.INVENTORY_COMMANDS, key(order), "ConfirmReservation",
                new Messages.ConfirmReservation(order.getId(), order.getReservationId()));
    }

    private void releaseReservation(Order order) {
        this.outbox.enqueue(Topics.INVENTORY_COMMANDS, key(order), "ReleaseReservation",
                new Messages.ReleaseReservation(order.getId(), order.getReservationId(),
                        CancelReason.PAYMENT_DECLINED.name()));
    }

    private void refundPayment(Order order, CancelReason reason) {
        this.outbox.enqueue(Topics.PAYMENT_COMMANDS, key(order), "RefundPayment",
                new Messages.RefundPayment(order.getId(), order.getTotalCents(), reason.name()));
    }

    // ------------------------------------------------------------------- finais

    private void refund(SagaState saga, Order order, CancelReason reason) {
        saga.compensateFor(reason);
        saga.moveTo(SagaStep.REFUNDING_PAYMENT, now(), deadline(now(), 1));
        refundPayment(order, reason);
    }

    private void cancel(SagaState saga, Order order, CancelReason reason) {
        Instant now = now();
        order.cancel(reason, now);
        saga.compensateFor(reason);
        saga.moveTo(SagaStep.COMPENSATED, now, null);
        this.outbox.enqueue(Topics.ORDER_EVENTS, key(order), "OrderCancelled",
                new Messages.OrderCancelled(order.getId(), order.getBuyerId(), order.getShowId(),
                        order.getReservationId(), order.getTotalCents(), reason.name(), now));
        finished(saga, OrderStatus.CANCELLED, "compensated");
    }

    private void finished(SagaState saga, OrderStatus status, String outcome) {
        this.ordersTotal.add(1, Attributes.of(STATUS, status.name()));
        this.sagaDuration.record(Duration.between(saga.getStartedAt(), now()).toMillis() / 1000.0,
                Attributes.of(SAGA, "purchase", OUTCOME, outcome));
    }

    private void retry(SagaState saga) {
        int attempt = saga.getAttempts() + 1;
        if (attempt > this.settings.maxAttempts()) {
            log.error("Saga do pedido {} sem resposta no passo {} depois de {} tentativas", saga.getOrderId(),
                    saga.getStep(), saga.getAttempts());
        }
        else {
            log.warn("Saga do pedido {} sem resposta no passo {}: tentativa {}", saga.getOrderId(), saga.getStep(),
                    attempt);
        }
        saga.retried(now(), deadline(now(), attempt));
    }

    // -------------------------------------------------------------------- apoio

    private boolean seatAlreadySold(Order order) {
        List<String> seats = order.getItems().stream().map(OrderItem::getSeatLabel).filter(seat -> seat != null)
                .toList();
        if (seats.isEmpty()) {
            return false;
        }
        UUID sector = order.getItems().getFirst().getSectorId();
        return this.tickets.countActive(order.getShowId(), sector, seats, order.getId()) > 0;
    }

    /** Prazo do passo, com espera dobrando a cada tentativa até 8 vezes o prazo base. */
    private Instant deadline(Instant now, int attempt) {
        long factor = 1L << Math.min(attempt - 1, 3);
        return now.plus(this.settings.stepTimeout().multipliedBy(factor));
    }

    private <T> T read(Envelope message, Class<T> type) {
        try {
            T payload = this.json.treeToValue(message.payload(), type);
            if (payload == null) {
                throw new MalformedMessageException(message.type() + " sem payload");
            }
            return payload;
        }
        catch (IllegalArgumentException | tools.jackson.core.JacksonException ex) {
            throw new MalformedMessageException(message.type() + " fora do contrato: " + ex.getMessage());
        }
    }

    private static List<Messages.Item> items(Order order) {
        return order.getItems().stream()
                .map(item -> new Messages.Item(item.getSectorId(), item.getSectorName(), item.getLotId(),
                        item.getLotName(), item.getSeatLabel(), item.getUnitPriceCents()))
                .toList();
    }

    private static String key(Order order) {
        return order.getId().toString();
    }

    private Instant now() {
        return this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
    }
}

package br.com.lotou.order.order;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.order.catalog.LocalShow;
import br.com.lotou.order.catalog.ShowCatalog;
import br.com.lotou.order.coupon.Coupon;
import br.com.lotou.order.coupon.CouponRepository;
import br.com.lotou.order.coupon.CouponService;
import br.com.lotou.order.inventory.InventoryClient;
import br.com.lotou.order.inventory.InventoryClient.InventoryUnavailableException;
import br.com.lotou.order.inventory.ReservationSnapshot;
import br.com.lotou.order.pricing.Pricing;
import br.com.lotou.order.pricing.Quote;
import br.com.lotou.order.refund.CancellationPolicy;
import br.com.lotou.order.saga.PurchaseSaga;
import br.com.lotou.order.shared.problem.ProblemException;
import br.com.lotou.order.shared.problem.Problems;
import io.opentelemetry.api.GlobalOpenTelemetry;
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

    /** Os valores de uma reserva, com o cupom que o comprador digitou (ou {@code null}). */
    public record Priced(Quote quote, Coupon coupon) {
    }

    private static final Logger log = LoggerFactory.getLogger(CheckoutService.class);

    private final OrderRepository orders;
    private final InventoryClient inventory;
    private final PurchaseSaga saga;
    private final ShowCatalog catalog;
    private final CouponService couponRules;
    private final CouponRepository coupons;
    private final EntityManager entityManager;
    private final TransactionTemplate transaction;
    private final Clock clock;

    private final LongCounter couponRedemptions;

    public CheckoutService(OrderRepository orders, InventoryClient inventory, PurchaseSaga saga, ShowCatalog catalog,
            CouponService couponRules, CouponRepository coupons, EntityManager entityManager,
            PlatformTransactionManager transactionManager, Clock clock) {
        this.orders = orders;
        this.inventory = inventory;
        this.saga = saga;
        this.catalog = catalog;
        this.couponRules = couponRules;
        this.coupons = coupons;
        this.couponRedemptions = GlobalOpenTelemetry.getMeter("lotou.order").counterBuilder("coupon_redemptions_total")
                .setDescription("Usos de cupom contados em pedidos criados")
                .build();
        this.entityManager = entityManager;
        this.transaction = new TransactionTemplate(transactionManager);
        this.clock = clock;
    }

    /**
     * Quanto o comprador vai pagar pela reserva, com a taxa do show e o cupom, sem criar nada. O
     * cupom é conferido agora, mas o uso só é contado ao criar o pedido.
     */
    public Priced quote(String buyerId, UUID reservationId, String couponCode) {
        ReservationSnapshot snapshot = fetchReservation(reservationId, buyerId);
        if (!snapshot.held() || !snapshot.reservation().expiresAt().isAfter(now())) {
            throw reservationNotHeld();
        }
        return price(snapshot.reservation(), couponCode);
    }

    /**
     * Cria o pedido da reserva e começa a saga. Com a mesma {@code Idempotency-Key}, ou para a mesma
     * reserva, devolve o pedido já criado, no estado em que está. O uso do cupom é contado na mesma
     * transação (ADR 33): se os usos acabaram nesse meio tempo, nada é criado.
     */
    public Outcome create(String buyerId, String idempotencyKey, UUID reservationId, String couponCode) {
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
                    .orElseThrow(CheckoutService::reservationNotHeld);
        }
        Priced priced = price(snapshot.reservation(), couponCode);
        Coupon coupon = priced.coupon();

        try {
            UUID orderId = this.transaction.execute(status -> {
                Order order = Order.pending(buyerId, idempotencyKey, snapshot.reservation(), priced.quote(),
                        coupon == null ? null : coupon.id(), coupon == null ? null : coupon.code(), now);
                this.entityManager.persist(order);
                // Grava o pedido antes da saga: o índice único de reserva decide a corrida aqui. O flush
                // pelo repositório traduz o erro de constraint para DataIntegrityViolationException.
                this.orders.flush();
                if (coupon != null && !this.coupons.redeem(coupon.id(), order.getId(),
                        priced.quote().discountCents(), now)) {
                    // Outro pedido levou o último uso (ou o produtor pausou) desde a conferência.
                    throw CouponService.invalid(Coupon.Refusal.EXHAUSTED);
                }
                this.saga.start(order);
                return order.getId();
            });
            if (coupon != null) {
                this.couponRedemptions.add(1);
            }
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
                .map(this::describe)
                .orElseThrow(() -> Problems.notFound("Pedido")));
    }

    /** O pedido como a API o devolve, com a decisão de cancelamento de agora. Exige transação. */
    public OrderResponse describe(Order order) {
        LocalShow show = this.catalog.find(order.getShowId()).orElse(null);
        return OrderResponse.of(order, CancellationPolicy.decide(order, show, now()));
    }

    private OrderResponse describe(UUID orderId) {
        return this.transaction.execute(status -> this.orders.findById(orderId).map(this::describe)
                .orElseThrow(() -> Problems.notFound("Pedido")));
    }

    /** Subtotal, desconto e taxa da reserva, com a taxa de quem o show diz que paga. */
    private Priced price(ReservationSnapshot.Reservation reservation, String couponCode) {
        LocalShow show = this.catalog.find(reservation.showId()).orElseThrow(() -> {
            // O show chega pelo shows.catalog; se ainda não chegou, o consumidor está atrasado.
            log.warn("Show {} ainda não está na cópia local do catálogo", reservation.showId());
            return new ProblemException(HttpStatus.SERVICE_UNAVAILABLE, "upstream-unavailable",
                    "Serviço indisponível", "Os dados do show ainda estão chegando. Tente novamente em instantes.");
        });
        Coupon coupon = couponCode == null || couponCode.isBlank() ? null
                : this.couponRules.resolve(reservation.showId(), reservation.sectorId(), couponCode);
        Quote quote = Pricing.quote(
                reservation.items().stream().map(ReservationSnapshot.Item::unitPriceCents).toList(),
                show.serviceFeePaidBy(), coupon == null ? null : coupon.discount());
        return new Priced(quote, coupon);
    }

    private static ProblemException reservationNotHeld() {
        return new ProblemException(HttpStatus.CONFLICT, "reservation-not-held", "Reserva não está mais ativa",
                "A reserva expirou ou já foi usada. Reserve os ingressos de novo.");
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

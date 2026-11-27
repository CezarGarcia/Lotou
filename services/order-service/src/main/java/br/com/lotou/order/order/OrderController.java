package br.com.lotou.order.order;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.coupon.Coupon;
import br.com.lotou.order.pricing.Quote;
import br.com.lotou.order.pricing.ServiceFeePayer;
import br.com.lotou.order.refund.RefundService;
import br.com.lotou.order.shared.problem.ProblemException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import org.springframework.data.domain.Limit;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Pedidos do comprador. */
@RestController
@RequestMapping("/v1/orders")
@Validated
class OrderController {

    static final String IDEMPOTENCY_KEY = "Idempotency-Key";
    static final String REPLAYED = "Idempotent-Replayed";

    /** @param couponCode o cupom que o comprador digitou; opcional */
    record CreateOrderRequest(@NotNull(message = "Informe a reserva") UUID reservationId,
            @Size(max = 64, message = "Use até 64 caracteres") String couponCode) {
    }

    /** O cupom aplicado na cotação. */
    record AppliedCoupon(String code, Coupon.Kind kind, Integer percent, Long amountCents) {
    }

    record QuoteResponse(long subtotalCents, long discountCents, long serviceFeeCents,
            ServiceFeePayer serviceFeePaidBy, long totalCents, AppliedCoupon coupon) {
    }

    /** Pedido com estorno que falhou, para o produtor tratar. */
    record FailedRefund(UUID orderId, String buyerId, long totalCents, Instant confirmedAt) {
    }

    private final CheckoutService checkout;
    private final RefundService refunds;
    private final OrderRepository orders;

    OrderController(CheckoutService checkout, RefundService refunds, OrderRepository orders) {
        this.checkout = checkout;
        this.refunds = refunds;
        this.orders = orders;
    }

    /** Quanto a reserva vai custar, com a taxa e o cupom, sem criar nada. */
    @PostMapping("/quote")
    QuoteResponse quote(@AuthenticationPrincipal Jwt jwt, @Valid @RequestBody CreateOrderRequest request) {
        CheckoutService.Priced priced = this.checkout.quote(jwt.getSubject(), request.reservationId(),
                request.couponCode());
        Quote quote = priced.quote();
        Coupon coupon = priced.coupon();
        return new QuoteResponse(quote.subtotalCents(), quote.discountCents(), quote.serviceFeeCents(),
                quote.serviceFeePaidBy(), quote.totalCents(), coupon == null ? null
                        : new AppliedCoupon(coupon.code(), coupon.kind(), coupon.percent(), coupon.amountCents()));
    }

    /**
     * Fecha a compra de uma reserva. A resposta traz o pedido PENDING: o pagamento e a emissão dos
     * ingressos seguem pela saga, e o cliente acompanha o {@code status} pelo {@code GET}. Uma
     * repetição devolve o pedido no estado em que estiver.
     */
    @PostMapping
    ResponseEntity<OrderResponse> create(@AuthenticationPrincipal Jwt jwt,
            @RequestHeader(IDEMPOTENCY_KEY)
            @Pattern(regexp = "[\\x21-\\x7e]{1,255}", message = "Use de 1 a 255 caracteres ASCII visíveis")
            String idempotencyKey,
            @Valid @RequestBody CreateOrderRequest request) {
        CheckoutService.Outcome outcome = this.checkout.create(jwt.getSubject(), idempotencyKey,
                request.reservationId(), request.couponCode());
        var response = ResponseEntity.created(URI.create("/v1/orders/" + outcome.order().id()));
        if (outcome.replayed()) {
            response.header(REPLAYED, "true");
        }
        return response.body(outcome.order());
    }

    @GetMapping("/{id}")
    OrderResponse get(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        return this.checkout.getOwned(id, jwt.getSubject());
    }

    /**
     * O comprador cancela o pedido inteiro, com reembolso integral. {@code 202}: os ingressos são
     * cancelados na hora e o estorno segue pela saga de reembolso. Repetir é seguro.
     */
    @PostMapping("/{id}/cancel")
    @Transactional
    ResponseEntity<OrderResponse> cancel(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        Order order = this.refunds.cancelByBuyer(id, jwt.getSubject());
        return ResponseEntity.accepted().body(this.checkout.describe(order));
    }

    /** O produtor manda tentar de novo um estorno que falhou. */
    @PostMapping("/{id}/refund/retry")
    @Transactional
    ResponseEntity<OrderResponse> retryRefund(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        Order order = this.refunds.retry(id, jwt.getSubject());
        return ResponseEntity.accepted().body(this.checkout.describe(order));
    }

    /** Pedidos do show com estorno que falhou cinco vezes. */
    @GetMapping("/refund-failed")
    List<FailedRefund> refundFailed(@RequestParam UUID showId, @AuthenticationPrincipal Jwt jwt) {
        return this.refunds.failed(showId, jwt.getSubject()).stream()
                .map(order -> new FailedRefund(order.getId(), order.getBuyerId(), order.getTotalCents(),
                        order.getConfirmedAt()))
                .toList();
    }

    /** "Meus pedidos", do mais novo ao mais antigo, paginados por cursor. */
    @GetMapping
    @Transactional(readOnly = true)
    OrderResponse.Page list(@AuthenticationPrincipal Jwt jwt,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit,
            @RequestParam(required = false) String cursor) {
        Limit page = Limit.of(limit + 1); // um a mais: se vier, existe próxima página
        List<Order> found = cursor == null ? this.orders.findByBuyer(jwt.getSubject(), page)
                : this.orders.findByBuyerBefore(jwt.getSubject(), decode(cursor), page);
        List<Order> items = found.stream().limit(limit).toList();
        String next = found.size() > limit ? encode(items.getLast().getId()) : null;
        return new OrderResponse.Page(items.stream().map(OrderResponse.Summary::of).toList(), next);
    }

    private static String encode(UUID id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(id.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** O cursor é opaco para o cliente, mas é entrada do cliente: validado antes de chegar à consulta. */
    private static UUID decode(String cursor) {
        try {
            return UUID.fromString(new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8));
        }
        catch (IllegalArgumentException ex) {
            throw new ProblemException(HttpStatus.BAD_REQUEST, "validation-error", "Requisição inválida",
                    "Um ou mais campos da requisição são inválidos.")
                    .with("errors", List.of(java.util.Map.of("field", "cursor", "message", "Cursor inválido")));
        }
    }
}

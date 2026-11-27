package br.com.lotou.order.coupon;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import br.com.lotou.order.shared.problem.ProblemException;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Cupons do produtor, por show (contracts/api-fase-6.md). */
@RestController
@RequestMapping("/v1/coupons")
@Validated
class CouponController {

    record CreateCouponRequest(@NotNull UUID showId, @NotBlank String code, @NotNull Coupon.Kind kind,
            Integer percent, Long amountCents, @Min(1) int maxUses, @NotNull Instant validUntil,
            List<UUID> sectorIds) {
    }

    record CouponResponse(UUID id, UUID showId, String code, Coupon.Kind kind, Integer percent, Long amountCents,
            int maxUses, int uses, int remaining, String status, Instant validUntil, List<UUID> sectorIds,
            long discountGivenCents, Instant createdAt) {
    }

    record Page(List<CouponResponse> items, String nextCursor) {
    }

    private final CouponService coupons;
    private final java.time.Clock clock;

    CouponController(CouponService coupons, java.time.Clock clock) {
        this.coupons = coupons;
        this.clock = clock;
    }

    @PostMapping
    ResponseEntity<CouponResponse> create(@AuthenticationPrincipal Jwt jwt,
            @RequestHeader("Idempotency-Key") String idempotencyKey, @Valid @RequestBody CreateCouponRequest body) {
        Coupon coupon = this.coupons.create(jwt.getSubject(), idempotencyKey,
                new CouponService.NewCoupon(body.showId(), body.code(), body.kind(), body.percent(),
                        body.amountCents(), body.maxUses(), body.validUntil(), body.sectorIds()));
        return ResponseEntity.created(URI.create("/v1/coupons/" + coupon.id())).body(describe(coupon));
    }

    @GetMapping
    Page list(@AuthenticationPrincipal Jwt jwt, @RequestParam UUID showId,
            @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit,
            @RequestParam(required = false) String cursor) {
        List<Coupon> found = this.coupons.list(jwt.getSubject(), showId, cursor == null ? null : decode(cursor),
                limit + 1);
        List<Coupon> items = found.stream().limit(limit).toList();
        String next = found.size() > limit ? encode(items.getLast().id()) : null;
        return new Page(items.stream().map(this::describe).toList(), next);
    }

    @PostMapping("/{id}/pause")
    CouponResponse pause(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return describe(this.coupons.setStatus(jwt.getSubject(), id, Coupon.Status.PAUSED));
    }

    @PostMapping("/{id}/resume")
    CouponResponse resume(@AuthenticationPrincipal Jwt jwt, @PathVariable UUID id) {
        return describe(this.coupons.setStatus(jwt.getSubject(), id, Coupon.Status.ACTIVE));
    }

    private CouponResponse describe(Coupon coupon) {
        return new CouponResponse(coupon.id(), coupon.showId(), coupon.code(), coupon.kind(), coupon.percent(),
                coupon.amountCents(), coupon.maxUses(), coupon.uses(), coupon.maxUses() - coupon.uses(),
                coupon.displayStatus(this.clock.instant()), coupon.validUntil(), coupon.sectorIds(),
                this.coupons.discountGiven(coupon.id()), coupon.createdAt());
    }

    private static String encode(UUID id) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(id.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static UUID decode(String cursor) {
        try {
            return UUID.fromString(new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8));
        }
        catch (IllegalArgumentException ex) {
            throw new ProblemException(HttpStatus.BAD_REQUEST, "validation-error", "Requisição inválida",
                    "Cursor inválido.");
        }
    }
}

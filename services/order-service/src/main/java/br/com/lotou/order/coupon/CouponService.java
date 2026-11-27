package br.com.lotou.order.coupon;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;

import br.com.lotou.order.catalog.LocalShow;
import br.com.lotou.order.catalog.ShowCatalog;
import br.com.lotou.order.shared.UuidV7;
import br.com.lotou.order.shared.problem.ProblemException;
import br.com.lotou.order.shared.problem.Problems;

import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/** Cupons do produtor: criar, listar, pausar e retomar, e resolver um código num pedido. */
@Service
public class CouponService {

    private static final Pattern CODE = Pattern.compile("[A-Z0-9][A-Z0-9_-]{2,29}");

    /** O que o produtor envia para criar um cupom. */
    public record NewCoupon(UUID showId, String code, Coupon.Kind kind, Integer percent, Long amountCents,
            int maxUses, Instant validUntil, List<UUID> sectorIds) {
    }

    private final CouponRepository coupons;
    private final ShowCatalog catalog;
    private final Clock clock;

    public CouponService(CouponRepository coupons, ShowCatalog catalog, Clock clock) {
        this.coupons = coupons;
        this.catalog = catalog;
        this.clock = clock;
    }

    /** Cria o cupom. Com a mesma {@code Idempotency-Key}, devolve o que já foi criado. */
    public Coupon create(String producerId, String idempotencyKey, NewCoupon request) {
        var existing = this.coupons.findByIdempotencyKey(producerId, idempotencyKey);
        if (existing.isPresent()) {
            return existing.get();
        }
        ownedShow(request.showId(), producerId);
        String code = request.code().trim().toUpperCase(Locale.ROOT);
        validate(request, code);
        Coupon coupon = new Coupon(UuidV7.generate(), request.showId(), code, request.kind(),
                request.kind() == Coupon.Kind.PERCENT ? request.percent() : null,
                request.kind() == Coupon.Kind.AMOUNT ? request.amountCents() : null, request.maxUses(), 0,
                Coupon.Status.ACTIVE, request.validUntil(),
                request.sectorIds() == null ? List.of() : List.copyOf(request.sectorIds()), now());
        try {
            this.coupons.insert(coupon, producerId, idempotencyKey);
            return coupon;
        }
        catch (DuplicateKeyException ex) {
            // Duas requisições com a mesma chave chegaram juntas, ou o código já existe no show.
            return this.coupons.findByIdempotencyKey(producerId, idempotencyKey)
                    .orElseThrow(() -> new ProblemException(HttpStatus.CONFLICT, "coupon-code-taken",
                            "Código já usado", "Já existe um cupom com o código " + code + " neste show."));
        }
    }

    public List<Coupon> list(String producerId, UUID showId, UUID before, int limit) {
        ownedShow(showId, producerId);
        return this.coupons.list(showId, before, limit);
    }

    public Coupon setStatus(String producerId, UUID couponId, Coupon.Status status) {
        Coupon coupon = this.coupons.findById(couponId).orElseThrow(() -> Problems.notFound("Cupom"));
        ownedShow(coupon.showId(), producerId);
        this.coupons.setStatus(couponId, status, now());
        return this.coupons.findById(couponId).orElseThrow();
    }

    public long discountGiven(UUID couponId) {
        return this.coupons.discountGiven(couponId);
    }

    /**
     * O cupom que o comprador digitou, se ele serve para o show e o setor agora. Senão,
     * {@code coupon-invalid} com o motivo.
     */
    public Coupon resolve(UUID showId, UUID sectorId, String rawCode) {
        String code = rawCode.trim().toUpperCase(Locale.ROOT);
        Coupon coupon = this.coupons.findByCode(showId, code)
                .orElseThrow(() -> invalid(Coupon.Refusal.NOT_FOUND));
        Coupon.Refusal refusal = coupon.refusalFor(showId, sectorId, now());
        if (refusal != null) {
            throw invalid(refusal);
        }
        return coupon;
    }

    public static ProblemException invalid(Coupon.Refusal reason) {
        String detail = switch (reason) {
            case NOT_FOUND -> "Este cupom não existe para este show.";
            case EXPIRED -> "Este cupom venceu.";
            case PAUSED -> "Este cupom está pausado pelo produtor.";
            case EXHAUSTED -> "Os usos deste cupom acabaram.";
            case WRONG_SHOW -> "Este cupom é de outro show.";
            case WRONG_SECTOR -> "Este cupom não vale para este setor.";
        };
        return new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "coupon-invalid", "Cupom não aplicado", detail)
                .with("reason", reason.name());
    }

    private void validate(NewCoupon request, String code) {
        var errors = new java.util.ArrayList<String>();
        if (!CODE.matcher(code).matches()) {
            errors.add("code: use de 3 a 30 letras, números, hífen ou sublinhado, começando por letra ou número");
        }
        if (request.kind() == Coupon.Kind.PERCENT && (request.percent() == null || request.percent() < 1
                || request.percent() > 100)) {
            errors.add("percent: informe de 1 a 100");
        }
        if (request.kind() == Coupon.Kind.AMOUNT && (request.amountCents() == null || request.amountCents() <= 0)) {
            errors.add("amountCents: informe um valor maior que zero, em centavos");
        }
        if (request.maxUses() < 1) {
            errors.add("maxUses: no mínimo 1");
        }
        if (request.validUntil() == null || !request.validUntil().isAfter(now())) {
            errors.add("validUntil: precisa ser uma data futura");
        }
        if (!errors.isEmpty()) {
            throw new ProblemException(HttpStatus.BAD_REQUEST, "validation-error", "Requisição inválida",
                    String.join("; ", errors));
        }
    }

    /** O show, se for do produtor. Show de outro produtor é 404, não 403. */
    private LocalShow ownedShow(UUID showId, String producerId) {
        return this.catalog.find(showId).filter(show -> show.producerId().equals(producerId))
                .orElseThrow(() -> Problems.notFound("Show"));
    }

    private Instant now() {
        return this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
    }
}

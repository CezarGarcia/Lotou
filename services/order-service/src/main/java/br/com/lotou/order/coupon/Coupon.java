package br.com.lotou.order.coupon;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import br.com.lotou.order.pricing.Pricing;

/** Um cupom de desconto de um show. O uso é contado no banco, na transação do pedido (ADR 33). */
public record Coupon(UUID id, UUID showId, String code, Kind kind, Integer percent, Long amountCents, int maxUses,
        int uses, Status status, Instant validUntil, List<UUID> sectorIds, Instant createdAt) {

    public enum Kind {
        PERCENT, AMOUNT
    }

    /** O que o produtor controla: ativo ou pausado. Vencido e esgotado são calculados. */
    public enum Status {
        ACTIVE, PAUSED
    }

    /** Por que um cupom não serve para um pedido. */
    public enum Refusal {
        NOT_FOUND, EXPIRED, PAUSED, EXHAUSTED, WRONG_SHOW, WRONG_SECTOR
    }

    public Pricing.Discount discount() {
        return this.kind == Kind.PERCENT ? new Pricing.Discount.Percent(this.percent)
                : new Pricing.Discount.Amount(this.amountCents);
    }

    /** O que impede o cupom de ser usado agora, no setor; {@code null} se ele serve. */
    public Refusal refusalFor(UUID showId, UUID sectorId, Instant now) {
        if (!this.showId.equals(showId)) {
            return Refusal.WRONG_SHOW;
        }
        if (this.status == Status.PAUSED) {
            return Refusal.PAUSED;
        }
        if (!this.validUntil.isAfter(now)) {
            return Refusal.EXPIRED;
        }
        if (this.uses >= this.maxUses) {
            return Refusal.EXHAUSTED;
        }
        if (!this.sectorIds.isEmpty() && !this.sectorIds.contains(sectorId)) {
            return Refusal.WRONG_SECTOR;
        }
        return null;
    }

    /** Status como o produtor o vê: vencido e esgotado aparecem mesmo com o cupom ativo. */
    public String displayStatus(Instant now) {
        if (this.uses >= this.maxUses) {
            return "EXHAUSTED";
        }
        if (!this.validUntil.isAfter(now)) {
            return "EXPIRED";
        }
        return this.status.name();
    }
}

package br.com.lotou.order.pricing;

import java.util.List;

/**
 * As contas de um pedido (seção "Taxa de serviço" e "Cupons" de docs/projeto.md). Tudo em
 * centavos, com inteiros.
 *
 * <ul>
 *   <li>Taxa: 10% do valor de cada ingresso, antes do desconto, arredondada para o centavo mais
 *       próximo, ingresso a ingresso.
 *   <li>Cupom percentual: centavos arredondados para baixo, a favor do comprador. Cupom de valor:
 *       no máximo o subtotal. Nunca sobre a taxa, e nunca deixa os ingressos abaixo de zero.
 * </ul>
 */
public final class Pricing {

    static final int SERVICE_FEE_PERCENT = 10;

    private Pricing() {
    }

    /** Desconto que um cupom dá; {@code null} quando não há cupom. */
    public sealed interface Discount permits Discount.Percent, Discount.Amount {

        long applyTo(long subtotalCents);

        record Percent(int percent) implements Discount {

            @Override
            public long applyTo(long subtotalCents) {
                return Math.floorDiv(subtotalCents * this.percent, 100);
            }
        }

        record Amount(long amountCents) implements Discount {

            @Override
            public long applyTo(long subtotalCents) {
                return Math.min(this.amountCents, subtotalCents);
            }
        }
    }

    public static Quote quote(List<Long> unitPricesCents, ServiceFeePayer feePaidBy, Discount discount) {
        long subtotal = 0;
        long fee = 0;
        for (long unit : unitPricesCents) {
            subtotal += unit;
            fee += feeOf(unit);
        }
        long off = discount == null ? 0 : discount.applyTo(subtotal);
        long total = subtotal - off + (feePaidBy == ServiceFeePayer.BUYER ? fee : 0);
        return new Quote(subtotal, off, fee, feePaidBy, total);
    }

    /** 10% do ingresso, arredondado para o centavo mais próximo (meio centavo arredonda para cima). */
    static long feeOf(long unitCents) {
        return Math.floorDiv(unitCents * SERVICE_FEE_PERCENT + 50, 100);
    }
}

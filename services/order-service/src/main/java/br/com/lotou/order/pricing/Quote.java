package br.com.lotou.order.pricing;

/**
 * Os valores de um pedido, em centavos.
 *
 * @param subtotalCents soma dos ingressos, ao preço da reserva
 * @param discountCents desconto do cupom, só sobre os ingressos
 * @param serviceFeeCents taxa de serviço (10% de cada ingresso)
 * @param totalCents o que o comprador paga: subtotal - desconto + taxa, se for ele quem paga a taxa
 */
public record Quote(long subtotalCents, long discountCents, long serviceFeeCents, ServiceFeePayer serviceFeePaidBy,
        long totalCents) {
}

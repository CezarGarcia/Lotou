package br.com.lotou.order.order;

/** Por que um pedido pendente foi cancelado. */
public enum CancelReason {
    PAYMENT_DECLINED,
    RESERVATION_EXPIRED,
    /** A última defesa disparou: já existia um ingresso ativo para a mesma cadeira (ADR 4). */
    TICKET_CONFLICT
}

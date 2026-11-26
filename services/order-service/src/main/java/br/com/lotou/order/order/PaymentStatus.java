package br.com.lotou.order.order;

/** O que o pagamento do pedido respondeu, gravado antes do passo seguinte da saga. */
public enum PaymentStatus {
    AUTHORIZED,
    DECLINED,
    /** Aprovado e depois estornado: o pedido foi cancelado depois do pagamento. */
    REFUNDED
}

package br.com.lotou.order.payment;

import java.util.UUID;

/**
 * Porta do pagamento. O checkout só conhece esta interface.
 *
 * <p>Na fase 1 quem responde é um simulador dentro do próprio serviço ({@link
 * SimulatedPaymentGateway}). Na fase 3 a implementação passa a publicar o comando {@code
 * AuthorizePayment} para o payment-mock no Kafka, e o checkout continua igual.
 */
public interface PaymentGateway {

    enum Result {
        AUTHORIZED,
        DECLINED
    }

    /**
     * Autoriza a cobrança do pedido. O ID do pedido é a chave de idempotência: autorizar de novo o
     * mesmo pedido devolve a mesma resposta, sem cobrar duas vezes.
     */
    Result authorize(UUID orderId, long amountCents);

    /** Desfaz uma autorização cujo pedido não pôde ser concluído. Idempotente. */
    void voidAuthorization(UUID orderId);
}

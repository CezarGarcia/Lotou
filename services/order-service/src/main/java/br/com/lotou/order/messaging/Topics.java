package br.com.lotou.order.messaging;

/** Tópicos do Kafka que o order-service usa (contracts/README.md). */
public final class Topics {

    public static final String ORDER_EVENTS = "order.events";
    public static final String PAYMENT_COMMANDS = "payment.commands";
    public static final String PAYMENT_EVENTS = "payment.events";
    public static final String INVENTORY_COMMANDS = "inventory.commands";
    public static final String INVENTORY_EVENTS = "inventory.events";

    /** Para onde vai a mensagem que falhou depois das tentativas. */
    public static String deadLetterOf(String topic) {
        return topic + ".dlt";
    }

    private Topics() {
    }
}

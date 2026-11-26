package br.com.lotou.inventory.messaging;

/** Tópicos do Kafka que o inventory-service usa (contracts/README.md). */
public final class Topics {

    public static final String SHOWS_CATALOG = "shows.catalog";
    public static final String INVENTORY_COMMANDS = "inventory.commands";
    public static final String INVENTORY_EVENTS = "inventory.events";

    /** Para onde vai a mensagem que falhou depois das tentativas. */
    public static String deadLetterOf(String topic) {
        return topic + ".dlt";
    }

    private Topics() {
    }
}

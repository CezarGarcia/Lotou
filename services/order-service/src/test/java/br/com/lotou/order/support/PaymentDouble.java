package br.com.lotou.order.support;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Predicate;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Um payment-mock de teste que responde sozinho pelo Kafka: aprova os pagamentos, menos os dos
 * compradores que o teste mandar recusar, e estorna o que for pedido. Responde igual a um comando
 * repetido, como o payment-mock de verdade.
 */
public final class PaymentDouble implements AutoCloseable {

    private final JsonMapper json = JsonMapper.builder().build();
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final Map<UUID, String> decided = new ConcurrentHashMap<>();
    private final Map<UUID, AtomicInteger> authorizations = new ConcurrentHashMap<>();
    private volatile Predicate<String> declines = buyer -> false;

    private PaymentDouble(String bootstrapServers) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "payment-double-" + UUID.randomUUID());
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props);
        consumer.subscribe(List.of("payment.commands"));
        Thread.ofPlatform().daemon().name("payment-double").start(() -> {
            try (consumer) {
                while (this.running.get()) {
                    for (ConsumerRecord<String, String> record : consumer.poll(Duration.ofMillis(100))) {
                        answer(record);
                    }
                }
            }
        });
    }

    public static PaymentDouble start() {
        return new PaymentDouble(EndToEndEnvironment.KAFKA.getBootstrapServers());
    }

    /** Recusa o pagamento dos compradores que satisfazem o critério; aprova o resto. */
    public void declineWhen(Predicate<String> buyer) {
        this.declines = buyer;
    }

    /** Quantas vezes o pagamento do pedido foi pedido. */
    public int authorizationsOf(UUID orderId) {
        AtomicInteger count = this.authorizations.get(orderId);
        return count == null ? 0 : count.get();
    }

    private void answer(ConsumerRecord<String, String> record) {
        Contracts.assertValid(record.topic(), this.json.readTree(record.value()).get("type").asString(),
                record.value());
        JsonNode command = this.json.readTree(record.value());
        JsonNode payload = command.get("payload");
        UUID orderId = UUID.fromString(payload.get("orderId").asString());
        long amount = payload.get("amountCents").asLong();
        String type = command.get("type").asString();
        if (type.equals("AuthorizePayment")) {
            this.authorizations.computeIfAbsent(orderId, id -> new AtomicInteger()).incrementAndGet();
            String result = this.decided.computeIfAbsent(orderId,
                    id -> this.declines.test(payload.get("buyerId").asString()) ? "PaymentDeclined"
                            : "PaymentAuthorized");
            reply(orderId, result, amount);
        }
        else if (type.equals("RefundPayment")) {
            reply(orderId, "PaymentRefunded", amount);
        }
    }

    private void reply(UUID orderId, String type, long amountCents) {
        ObjectNode payload = this.json.createObjectNode();
        payload.put("orderId", orderId.toString());
        payload.put("paymentId", UUID.nameUUIDFromBytes(orderId.toString().getBytes()).toString());
        payload.put("amountCents", amountCents);
        String now = Instant.now().toString();
        switch (type) {
            case "PaymentAuthorized" -> payload.put("authorizedAt", now);
            case "PaymentDeclined" -> payload.put("reason", "CARD_DECLINED").put("declinedAt", now);
            default -> payload.put("refundedAt", now);
        }
        ObjectNode envelope = this.json.createObjectNode();
        envelope.put("eventId", UUID.randomUUID().toString());
        envelope.put("type", type);
        envelope.put("version", 1);
        envelope.put("occurredAt", now);
        envelope.set("payload", payload);
        Contracts.assertValid("payment.events", type, envelope.toString());
        TestKafka.send("payment.events", orderId.toString(), envelope.toString());
    }

    @Override
    public void close() {
        this.running.set(false);
    }
}

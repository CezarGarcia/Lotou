package br.com.lotou.order.support;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Properties;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.awaitility.Awaitility;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Faz o papel dos outros participantes da saga nos testes: lê os comandos e eventos que o
 * order-service publica e responde como o payment-mock e o inventory responderiam. Tudo passa pelo
 * Kafka de verdade, e cada mensagem, nos dois sentidos, é conferida contra o contrato.
 */
public final class SagaCounterparts implements AutoCloseable {

    /** Uma mensagem lida de um tópico. */
    public record Message(String topic, String key, String type, JsonNode envelope) {

        public JsonNode payload() {
            return this.envelope.get("payload");
        }
    }

    private static final List<String> WATCHED = List.of("payment.commands", "inventory.commands", "order.events");

    private final JsonMapper json = JsonMapper.builder().build();
    private final KafkaProducer<String, String> producer;
    private final List<Message> received = new CopyOnWriteArrayList<>();
    private final AtomicBoolean running = new AtomicBoolean(true);
    private final Thread poller;

    private SagaCounterparts(String bootstrapServers) {
        Properties producerProps = new Properties();
        producerProps.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        producerProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        producerProps.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        this.producer = new KafkaProducer<>(producerProps);

        Properties consumerProps = new Properties();
        consumerProps.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrapServers);
        consumerProps.put(ConsumerConfig.GROUP_ID_CONFIG, "test-counterparts-" + UUID.randomUUID());
        consumerProps.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "latest");
        consumerProps.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        consumerProps.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class);
        KafkaConsumer<String, String> consumer = new KafkaConsumer<>(consumerProps);
        consumer.subscribe(WATCHED);
        // Espera a atribuição das partições: o que for publicado depois disso não se perde.
        Awaitility.await().atMost(Duration.ofSeconds(30)).until(() -> {
            consumer.poll(Duration.ofMillis(100));
            return !consumer.assignment().isEmpty();
        });
        consumer.seekToEnd(consumer.assignment());
        consumer.assignment().forEach(consumer::position);
        this.poller = Thread.ofPlatform().daemon().name("saga-counterparts").start(() -> {
            try (consumer) {
                while (this.running.get()) {
                    for (ConsumerRecord<String, String> record : consumer.poll(Duration.ofMillis(100))) {
                        JsonNode envelope = this.json.readTree(record.value());
                        String type = envelope.get("type").asString();
                        Contracts.assertValid(record.topic(), type, record.value());
                        this.received.add(new Message(record.topic(), record.key(), type, envelope));
                    }
                }
            }
        });
    }

    public static SagaCounterparts start() {
        return new SagaCounterparts(EndToEndEnvironment.KAFKA.getBootstrapServers());
    }

    /** Espera o order-service publicar uma mensagem do tipo, para o pedido, e a devolve. */
    public Message await(String type, UUID orderId) {
        return Awaitility.await().atMost(Duration.ofSeconds(15)).until(() -> find(type, orderId), m -> m != null);
    }

    /** Quantas mensagens do tipo o order-service publicou para o pedido até agora. */
    public long count(String type, UUID orderId) {
        return this.received.stream().filter(m -> matches(m, type, orderId)).count();
    }

    /** Todas as mensagens publicadas para o pedido, na ordem em que chegaram. */
    public List<String> typesFor(UUID orderId) {
        return this.received.stream().filter(m -> orderId.toString().equals(m.key())).map(Message::type).toList();
    }

    /** Responde como o payment-mock: PaymentAuthorized, PaymentDeclined, PaymentRefunded ou RefundFailed. */
    public UUID payment(String type, UUID orderId, long amountCents) {
        ObjectNode payload = this.json.createObjectNode();
        payload.put("orderId", orderId.toString());
        payload.put("paymentId", UUID.randomUUID().toString());
        payload.put("amountCents", amountCents);
        Instant now = Instant.now();
        switch (type) {
            case "PaymentAuthorized" -> payload.put("authorizedAt", now.toString());
            case "PaymentDeclined" -> payload.put("reason", "CARD_DECLINED").put("declinedAt", now.toString());
            case "PaymentRefunded" -> payload.put("refundedAt", now.toString());
            case "RefundFailed" -> payload.put("attempt", 1).put("failedAt", now.toString());
            default -> throw new IllegalArgumentException(type);
        }
        return send("payment.events", orderId.toString(), type, payload);
    }

    /** Publica um fato do inventory sobre a reserva: ReservationConfirmed ou ReservationReleased. */
    public UUID reservation(String type, UUID reservationId, UUID showId, String reason) {
        ObjectNode payload = this.json.createObjectNode();
        payload.put("reservationId", reservationId.toString());
        payload.put("showId", showId.toString());
        payload.put("sectorId", UUID.randomUUID().toString());
        payload.put("lotId", UUID.randomUUID().toString());
        payload.put("quantity", 1);
        payload.putArray("seats");
        if (type.equals("ReservationConfirmed")) {
            payload.put("confirmedAt", Instant.now().toString());
        }
        else {
            payload.put("reason", reason);
            payload.put("releasedAt", Instant.now().toString());
        }
        return send("inventory.events", showId.toString(), type, payload);
    }

    /** Publica de novo uma mensagem já enviada, com o mesmo eventId: o que o Kafka faz numa reentrega. */
    public void redeliver(String topic, String key, UUID eventId, String type, JsonNode payload) {
        sendEnvelope(topic, key, envelope(eventId, type, payload));
    }

    /** Publica um texto qualquer no tópico (mensagem malformada). */
    public void raw(String topic, String key, String value) {
        this.producer.send(new ProducerRecord<>(topic, key, value));
        this.producer.flush();
    }

    private UUID send(String topic, String key, String type, JsonNode payload) {
        UUID eventId = UUID.randomUUID();
        ObjectNode envelope = envelope(eventId, type, payload);
        Contracts.assertValid(topic, type, envelope.toString());
        sendEnvelope(topic, key, envelope);
        return eventId;
    }

    private ObjectNode envelope(UUID eventId, String type, JsonNode payload) {
        ObjectNode envelope = this.json.createObjectNode();
        envelope.put("eventId", eventId.toString());
        envelope.put("type", type);
        envelope.put("version", 1);
        envelope.put("occurredAt", Instant.now().toString());
        envelope.set("payload", payload);
        return envelope;
    }

    private void sendEnvelope(String topic, String key, ObjectNode envelope) {
        try {
            this.producer.send(new ProducerRecord<>(topic, key, envelope.toString())).get();
        }
        catch (Exception ex) {
            throw new IllegalStateException("Falha ao publicar no Kafka de teste", ex);
        }
    }

    private Message find(String type, UUID orderId) {
        return this.received.stream().filter(m -> matches(m, type, orderId)).findFirst().orElse(null);
    }

    private static boolean matches(Message message, String type, UUID orderId) {
        return message.type().equals(type) && orderId.toString().equals(message.key());
    }

    @Override
    public void close() {
        this.running.set(false);
        this.producer.close(Duration.ofSeconds(5));
    }

    /** Para os testes que montam um payload à mão. */
    public JsonMapper json() {
        return this.json;
    }
}

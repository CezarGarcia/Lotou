package br.com.lotou.order.support;

import java.util.Map;

import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;

/** Publica mensagens no Kafka dos testes, como os outros serviços publicariam. */
public final class TestKafka {

    private static final class Holder {
        private static final KafkaProducer<String, String> PRODUCER = new KafkaProducer<>(Map.of(
                ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, EndToEndEnvironment.KAFKA.getBootstrapServers(),
                ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
                ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class));
    }

    private TestKafka() {
    }

    public static void send(String topic, String key, String value) {
        try {
            Holder.PRODUCER.send(new ProducerRecord<>(topic, key, value)).get();
        }
        catch (Exception ex) {
            throw new IllegalStateException("Falha ao publicar no Kafka de teste", ex);
        }
    }
}

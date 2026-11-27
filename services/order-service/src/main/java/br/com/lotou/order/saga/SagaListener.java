package br.com.lotou.order.saga;

import br.com.lotou.order.messaging.Envelope;
import br.com.lotou.order.messaging.Topics;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Recebe as respostas dos passos da saga: o que o payment-mock respondeu e os fatos do inventory
 * sobre as reservas. Cada mensagem é tratada numa transação; se ela falhar, o Kafka a entrega de
 * novo (veja {@code KafkaConfig}).
 */
@Component
public class SagaListener {

    private static final Logger log = LoggerFactory.getLogger(SagaListener.class);

    private final PurchaseSaga saga;
    private final JsonMapper json;

    public SagaListener(PurchaseSaga saga, JsonMapper json) {
        this.saga = saga;
        this.json = json;
    }

    @KafkaListener(id = "purchase-saga", groupId = "order-service",
            topics = { Topics.PAYMENT_EVENTS, Topics.INVENTORY_EVENTS })
    public void onMessage(ConsumerRecord<String, String> record) {
        Envelope message = Envelope.parse(this.json, record);
        if (this.saga.handle(record.topic(), message)) {
            log.debug("{} {} aplicado à saga (chave {})", record.topic(), message.type(), record.key());
        }
    }
}

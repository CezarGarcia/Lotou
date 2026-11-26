package br.com.lotou.inventory.messaging;

import org.apache.kafka.clients.consumer.ConsumerRecord;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.stereotype.Component;

/** Lê o envelope e o payload de uma mensagem; o que não segue o contrato vai para a DLT. */
@Component
public class MessageReader {

    private final JsonMapper json;

    public MessageReader(JsonMapper json) {
        this.json = json;
    }

    public Envelope envelope(ConsumerRecord<String, String> record) {
        try {
            Envelope message = this.json.readValue(record.value(), Envelope.class);
            if (message.eventId() == null || message.type() == null || message.payload() == null) {
                throw new MalformedMessageException("Envelope incompleto em " + record.topic());
            }
            return message;
        }
        catch (JacksonException ex) {
            throw new MalformedMessageException("Envelope ilegível em " + record.topic() + ": " + ex.getMessage());
        }
    }

    public <T> T payload(Envelope message, Class<T> type) {
        try {
            T payload = this.json.treeToValue(message.payload(), type);
            if (payload == null) {
                throw new MalformedMessageException(message.type() + " sem payload");
            }
            return payload;
        }
        catch (IllegalArgumentException | JacksonException ex) {
            throw new MalformedMessageException(message.type() + " fora do contrato: " + ex.getMessage());
        }
    }
}

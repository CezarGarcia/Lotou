package br.com.lotou.order.order;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

import br.com.lotou.order.messaging.Envelope;
import br.com.lotou.order.messaging.MalformedMessageException;
import br.com.lotou.order.messaging.Topics;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Marca como USED o ingresso que passou pela portaria ({@code TicketCheckedIn}, do
 * checkin-service). Quem barra a entrada dupla é a portaria; aqui o ingresso usado só impede o
 * cancelamento pelo comprador e aparece em "Meus ingressos". Idempotente pelo estado do ingresso.
 */
@Component
public class CheckinListener {

    private static final Logger log = LoggerFactory.getLogger(CheckinListener.class);

    record CheckedIn(UUID ticketId, String gate, Instant checkedInAt) {
    }

    private final OrderRepository orders;
    private final JsonMapper json;
    private final Clock clock;

    public CheckinListener(OrderRepository orders, JsonMapper json, Clock clock) {
        this.orders = orders;
        this.json = json;
        this.clock = clock;
    }

    @KafkaListener(id = "order-checkins", groupId = "order-service-checkins", topics = Topics.CHECKIN_EVENTS)
    @Transactional
    public void onMessage(ConsumerRecord<String, String> record) {
        Envelope message = Envelope.parse(this.json, record);
        if (!"TicketCheckedIn".equals(message.type())) {
            return; // CheckinRejected não muda o ingresso.
        }
        CheckedIn checkin = read(message);
        this.orders.lockByTicketId(checkin.ticketId()).ifPresentOrElse(order -> {
            Instant now = this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
            if (!order.checkIn(checkin.ticketId(), checkin.checkedInAt(), checkin.gate(), now)) {
                log.warn("Entrada do ingresso {} registrada, mas ele não estava válido no pedido {} ({})",
                        checkin.ticketId(), order.getId(), order.getStatus());
            }
        }, () -> log.warn("Entrada de um ingresso que este serviço não conhece: {}", checkin.ticketId()));
    }

    private CheckedIn read(Envelope message) {
        try {
            CheckedIn checkin = this.json.treeToValue(message.payload(), CheckedIn.class);
            if (checkin == null || checkin.ticketId() == null || checkin.gate() == null
                    || checkin.checkedInAt() == null) {
                throw new MalformedMessageException("TicketCheckedIn sem os campos do contrato");
            }
            return checkin;
        }
        catch (IllegalArgumentException | JacksonException ex) {
            throw new MalformedMessageException("TicketCheckedIn fora do contrato: " + ex.getMessage());
        }
    }
}

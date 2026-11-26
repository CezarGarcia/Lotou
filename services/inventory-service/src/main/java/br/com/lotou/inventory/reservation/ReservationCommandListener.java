package br.com.lotou.inventory.reservation;

import java.util.UUID;

import br.com.lotou.inventory.messaging.Envelope;
import br.com.lotou.inventory.messaging.MessageReader;
import br.com.lotou.inventory.messaging.Topics;
import br.com.lotou.inventory.shared.problem.ProblemException;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Os comandos da saga de compra (inventory.commands): confirmar a reserva de um pedido pago, ou
 * devolvê-la à venda quando o pagamento foi recusado.
 *
 * <p>Não há resposta direta ao comando. O que a saga espera são os fatos sobre a reserva
 * (ReservationConfirmed, ReservationReleased), que o banco grava no outbox quando o status muda,
 * venha a mudança daqui, da expiração ou de outro motor. Por isso os comandos não precisam de
 * {@code processed_events}: confirmar uma reserva já confirmada, ou liberar uma já devolvida, não
 * muda nada nem gera fato novo. Um comando que chega tarde (a reserva expirou antes) também não:
 * o fato da expiração já foi publicado, e a saga reage a ele.
 */
@Component
public class ReservationCommandListener {

    private static final Logger log = LoggerFactory.getLogger(ReservationCommandListener.class);

    record ReservationCommand(UUID orderId, UUID reservationId) {
    }

    private final ReservationService reservations;
    private final MessageReader reader;

    public ReservationCommandListener(ReservationService reservations, MessageReader reader) {
        this.reservations = reservations;
        this.reader = reader;
    }

    @KafkaListener(id = "reservation-commands", topics = Topics.INVENTORY_COMMANDS)
    public void onCommand(ConsumerRecord<String, String> record) {
        Envelope message = this.reader.envelope(record);
        switch (message.type()) {
            case "ConfirmReservation" -> apply(message, true);
            case "ReleaseReservation" -> apply(message, false);
            default -> log.debug("Comando ignorado: {}", message.type());
        }
    }

    private void apply(Envelope message, boolean confirm) {
        ReservationCommand command = this.reader.payload(message, ReservationCommand.class);
        try {
            if (confirm) {
                this.reservations.confirm(command.reservationId());
            }
            else {
                this.reservations.release(command.reservationId());
            }
        }
        catch (ProblemException ex) {
            if ("reservation-not-held".equals(ex.slug()) || "not-found".equals(ex.slug())) {
                // A reserva já não está segurada: o fato que a encerrou já foi (ou será) publicado.
                log.info("{} do pedido {} sem efeito: reserva {} não está mais segurada", message.type(),
                        command.orderId(), command.reservationId());
                return;
            }
            throw ex;
        }
    }
}

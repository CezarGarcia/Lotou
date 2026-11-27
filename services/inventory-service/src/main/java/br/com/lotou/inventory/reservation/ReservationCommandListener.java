package br.com.lotou.inventory.reservation;

import java.util.Set;
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
 * Os comandos das sagas do order-service (inventory.commands): confirmar a reserva de um pedido
 * pago, devolvê-la à venda quando o pagamento foi recusado, ou devolver à venda os ingressos de um
 * pedido cancelado e reembolsado.
 *
 * <p>Não há resposta direta ao comando. O que a saga espera são os fatos sobre a reserva
 * (ReservationConfirmed, ReservationReleased, ReservationReturned), que o banco grava no outbox
 * quando o status muda, venha a mudança daqui, da expiração ou de outro motor. Por isso os comandos
 * não precisam de {@code processed_events}: confirmar uma reserva já confirmada, liberar uma já
 * devolvida ou devolver de novo os ingressos não muda nada nem gera fato novo. Um comando que chega
 * tarde (a reserva expirou antes) também não: o fato da expiração já foi publicado, e a saga reage
 * a ele.
 */
@Component
public class ReservationCommandListener {

    private static final Logger log = LoggerFactory.getLogger(ReservationCommandListener.class);

    /** Recusas definitivas: repetir o comando não muda o resultado, então ele é registrado e ignorado. */
    private static final Set<String> NO_EFFECT = Set.of("reservation-not-held", "reservation-not-confirmed",
            "not-found");

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
            case "ConfirmReservation", "ReleaseReservation", "ReturnTickets" -> apply(message);
            default -> log.debug("Comando ignorado: {}", message.type());
        }
    }

    private void apply(Envelope message) {
        ReservationCommand command = this.reader.payload(message, ReservationCommand.class);
        try {
            switch (message.type()) {
                case "ConfirmReservation" -> this.reservations.confirm(command.reservationId());
                case "ReleaseReservation" -> this.reservations.release(command.reservationId());
                default -> this.reservations.returnTickets(command.reservationId());
            }
        }
        catch (ProblemException ex) {
            if (NO_EFFECT.contains(ex.slug())) {
                // A reserva não está no estado que o comando espera: o fato que a levou ao estado
                // atual já foi (ou será) publicado.
                log.info("{} do pedido {} sem efeito: reserva {} recusou ({})", message.type(), command.orderId(),
                        command.reservationId(), ex.slug());
                return;
            }
            // Transitório (o estoque do show está sendo recarregado no Redis): o tratador de erros
            // tenta de novo com espera crescente.
            throw ex;
        }
    }
}

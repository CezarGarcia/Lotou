package br.com.lotou.inventory.reservation;

import java.time.Clock;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.data.domain.Limit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Expira as reservas que passaram do prazo sem pagamento e devolve os ingressos à venda.
 *
 * <p>É uma varredura no Postgres, de propósito: a expiração precisa acontecer mesmo depois de uma
 * queda do serviço, e o banco é a fonte que não esquece. Cada reserva expira na própria
 * transação, com a linha travada, então várias instâncias podem varrer ao mesmo tempo.
 */
@Component
public class ReservationExpiryJob {

    private static final Logger log = LoggerFactory.getLogger(ReservationExpiryJob.class);
    private static final Limit BATCH = Limit.of(200);

    private final ReservationRepository reservations;
    private final ReservationService service;
    private final Clock clock;

    public ReservationExpiryJob(ReservationRepository reservations, ReservationService service, Clock clock) {
        this.reservations = reservations;
        this.service = service;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${lotou.inventory.jobs.expiry-interval:5s}")
    public void run() {
        int expired = expireDue();
        if (expired > 0) {
            log.info("Reservas expiradas: {}", expired);
        }
    }

    /** Expira um lote de reservas vencidas. Devolve quantas expiraram. */
    public int expireDue() {
        List<UUID> due = this.reservations.findExpiredIds(this.clock.instant(), BATCH);
        int expired = 0;
        for (UUID id : due) {
            try {
                if (this.service.expire(id)) {
                    expired++;
                }
            }
            catch (RuntimeException ex) {
                log.error("Falha ao expirar a reserva {}", id, ex);
            }
        }
        return expired;
    }
}

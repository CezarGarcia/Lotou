package br.com.lotou.inventory.lot;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

import br.com.lotou.inventory.catalog.ShowRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * De tempos em tempos, abre as vendas dos shows cujo horário chegou, vira os lotes com data
 * marcada e encerra as vendas. Não usa lock distribuído: cada passo trava a linha no Postgres e
 * confere a condição de novo, então várias instâncias podem rodar ao mesmo tempo.
 */
@Component
public class SalesLifecycleJob {

    private static final Logger log = LoggerFactory.getLogger(SalesLifecycleJob.class);

    private final ShowRepository shows;
    private final LotRepository lots;
    private final SalesLifecycle lifecycle;
    private final Clock clock;

    public SalesLifecycleJob(ShowRepository shows, LotRepository lots, SalesLifecycle lifecycle, Clock clock) {
        this.shows = shows;
        this.lots = lots;
        this.lifecycle = lifecycle;
        this.clock = clock;
    }

    @Scheduled(fixedDelayString = "${lotou.inventory.jobs.lifecycle-interval:1s}")
    public void run() {
        Instant now = this.clock.instant();
        for (UUID showId : this.shows.findIdsDueToOpen(now)) {
            attempt(() -> this.lifecycle.openSales(showId, now), "abrir as vendas do show " + showId);
        }
        for (SectorRef sector : this.lots.findSectorsDueToTurn(now)) {
            attempt(() -> this.lifecycle.turnByDate(sector, now), "virar o lote do setor " + sector);
        }
        for (UUID showId : this.shows.findIdsDueToClose(now)) {
            attempt(() -> this.lifecycle.closeSales(showId, now), "encerrar as vendas do show " + showId);
        }
    }

    /** Uma falha num show não impede os outros; a próxima rodada tenta de novo. */
    private void attempt(Runnable step, String description) {
        try {
            step.run();
        }
        catch (RuntimeException ex) {
            log.error("Falha ao {}", description, ex);
        }
    }
}

package br.com.lotou.inventory.catalog;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogShow.CatalogLot;
import br.com.lotou.inventory.catalog.CatalogShow.CatalogSector;
import br.com.lotou.inventory.catalog.CatalogShow.Row;
import br.com.lotou.inventory.messaging.Envelope;
import br.com.lotou.inventory.messaging.MessageReader;
import br.com.lotou.inventory.messaging.Topics;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

/**
 * Mantém a cópia local do catálogo a partir do tópico {@code shows.catalog} (substitui o polling
 * das fases 1 e 2, ADR 23).
 *
 * <p>Cada mensagem traz o show inteiro com a versão dele, e o {@link CatalogSynchronizer} só
 * aplica uma versão mais nova que a local. Assim, ler a mesma mensagem duas vezes, ou reler o
 * tópico compactado desde o começo (um consumer group novo), deixa a cópia igual.
 */
@Component
public class CatalogListener {

    private static final Logger log = LoggerFactory.getLogger(CatalogListener.class);

    /** O payload de ShowPublished e ShowUpdated (contracts/shows.catalog), no que o inventory usa. */
    record ShowSnapshot(UUID showId, int version, String producerId, ShowStatus status, Instant startsAt,
            Instant salesStartAt, Instant salesEndAt, boolean highDemand, List<Sector> sectors, Instant updatedAt) {

        record Sector(UUID id, String name, SectorKind kind, int capacity, List<Row> rows, List<Lot> lots) {
        }

        record Lot(UUID id, String name, long priceCents, int quantity, Instant opensAt) {
        }

        CatalogShow toCatalogShow() {
            return new CatalogShow(this.showId, this.producerId, this.status, this.version, this.updatedAt,
                    this.startsAt, this.salesStartAt, this.salesEndAt, this.highDemand,
                    this.sectors.stream()
                            .map(sector -> new CatalogSector(sector.id(), sector.name(), sector.kind(),
                                    sector.capacity(), sector.rows() == null ? List.of() : sector.rows(),
                                    sector.lots().stream()
                                            .map(lot -> new CatalogLot(lot.id(), lot.name(), lot.priceCents(),
                                                    lot.quantity(), lot.opensAt()))
                                            .toList()))
                            .toList());
        }
    }

    private final CatalogSynchronizer synchronizer;
    private final MessageReader reader;

    public CatalogListener(CatalogSynchronizer synchronizer, MessageReader reader) {
        this.synchronizer = synchronizer;
        this.reader = reader;
    }

    @KafkaListener(id = "catalog", topics = Topics.SHOWS_CATALOG)
    public void onShow(ConsumerRecord<String, String> record) {
        Envelope message = this.reader.envelope(record);
        if (!"ShowPublished".equals(message.type()) && !"ShowUpdated".equals(message.type())) {
            log.debug("Mensagem do catálogo ignorada: {}", message.type());
            return;
        }
        ShowSnapshot show = this.reader.payload(message, ShowSnapshot.class);
        this.synchronizer.apply(show.toCatalogShow());
    }
}

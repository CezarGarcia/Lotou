package br.com.lotou.order.catalog;

import java.time.Instant;
import java.util.UUID;

import br.com.lotou.order.messaging.Envelope;
import br.com.lotou.order.messaging.MalformedMessageException;
import br.com.lotou.order.messaging.Topics;
import br.com.lotou.order.pricing.ServiceFeePayer;
import br.com.lotou.order.refund.RefundService;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

/**
 * Mantém a cópia local do catálogo a partir de {@code shows.catalog}. Quando um show passa a
 * CANCELLED, os pedidos confirmados dele entram na fila de reembolso, na mesma transação.
 *
 * <p>Idempotente pela versão do show: mensagem repetida ou fora de ordem não muda nada.
 */
@Component
public class CatalogListener {

    private static final Logger log = LoggerFactory.getLogger(CatalogListener.class);

    /** O que o order-service lê de ShowPublished e ShowUpdated. */
    record ShowMessage(UUID showId, Integer version, String producerId, String status, String title,
            Instant startsAt, ServiceFeePayer serviceFeePaidBy) {
    }

    private final ShowCatalog catalog;
    private final RefundService refunds;
    private final JsonMapper json;

    public CatalogListener(ShowCatalog catalog, RefundService refunds, JsonMapper json) {
        this.catalog = catalog;
        this.refunds = refunds;
        this.json = json;
    }

    @KafkaListener(id = "order-catalog", groupId = "order-service-catalog", topics = Topics.SHOWS_CATALOG)
    @Transactional
    public void onMessage(ConsumerRecord<String, String> record) {
        Envelope message = Envelope.parse(this.json, record);
        if (!"ShowPublished".equals(message.type()) && !"ShowUpdated".equals(message.type())) {
            return;
        }
        ShowMessage show = read(message);
        LocalShow local = new LocalShow(show.showId(), show.producerId(), show.status(), show.title(),
                show.startsAt(), show.serviceFeePaidBy() == null ? ServiceFeePayer.BUYER : show.serviceFeePaidBy(),
                show.version());
        ShowCatalog.Applied applied = this.catalog.apply(local);
        if (applied == null) {
            return; // versão velha ou repetida
        }
        if (local.isCancelled() && !"CANCELLED".equals(applied.previousStatus())) {
            log.info("Show {} cancelado pelo produtor", local.id());
            this.refunds.queueCancelledShow(local.id());
        }
    }

    private ShowMessage read(Envelope message) {
        try {
            ShowMessage show = this.json.treeToValue(message.payload(), ShowMessage.class);
            if (show == null || show.showId() == null || show.version() == null || show.producerId() == null
                    || show.status() == null || show.title() == null || show.startsAt() == null) {
                throw new MalformedMessageException(message.type() + " sem os campos do contrato");
            }
            return show;
        }
        catch (IllegalArgumentException | JacksonException ex) {
            throw new MalformedMessageException(message.type() + " fora do contrato: " + ex.getMessage());
        }
    }
}

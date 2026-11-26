package br.com.lotou.inventory.catalog;

import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

/**
 * Cópia local do show, com o que o inventory precisa para vender: a janela de vendas e o estado.
 * Quem cria e altera esta linha é a leitura do catálogo ({@link CatalogSynchronizer}); o inventory
 * só marca quando abriu e encerrou as vendas.
 */
@Entity
@Table(name = "shows")
public class Show {

    @Id
    private UUID id;

    private String producerId;

    @Enumerated(EnumType.STRING)
    private ShowStatus status;

    private Instant startsAt;

    private Instant salesStartAt;

    private Instant salesEndAt;

    private boolean highDemand;

    private Instant salesOpenedAt;

    private Instant salesClosedAt;

    protected Show() {
    }

    public UUID getId() {
        return this.id;
    }

    public String getProducerId() {
        return this.producerId;
    }

    public ShowStatus getStatus() {
        return this.status;
    }

    public boolean salesOpened() {
        return this.salesOpenedAt != null;
    }

    public boolean salesClosed() {
        return this.salesClosedAt != null;
    }

    /** Chegou a hora de abrir as vendas, e elas ainda não foram abertas. */
    public boolean dueToOpen(Instant now) {
        return !salesOpened() && this.status.sellable() && this.salesStartAt != null
                && !this.salesStartAt.isAfter(now) && !salesWindowEnded(now);
    }

    /** As vendas estão abertas e precisam encerrar: o prazo acabou ou o show saiu de venda. */
    public boolean dueToClose(Instant now) {
        return salesOpened() && !salesClosed() && (salesWindowEnded(now) || !this.status.sellable());
    }

    private boolean salesWindowEnded(Instant now) {
        return this.salesEndAt != null && !this.salesEndAt.isAfter(now);
    }

    public void markSalesOpened(Instant now) {
        this.salesOpenedAt = now;
    }

    public void markSalesClosed(Instant now) {
        this.salesClosedAt = now;
    }
}

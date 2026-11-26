package br.com.lotou.inventory.catalog;

/** Estado do show no catálogo (event-service). Rascunho não chega ao inventory. */
public enum ShowStatus {
    PUBLISHED,
    ON_SALE,
    SALES_CLOSED,
    FINISHED,
    CANCELLED;

    /** O show ainda pode vender ingressos. */
    public boolean sellable() {
        return this == PUBLISHED || this == ON_SALE;
    }
}

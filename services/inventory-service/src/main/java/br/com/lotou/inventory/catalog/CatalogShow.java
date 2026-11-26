package br.com.lotou.inventory.catalog;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * O show como o inventory o guarda na cópia local do catálogo. Chega pelo tópico
 * {@code shows.catalog} ({@link CatalogListener}).
 */
public record CatalogShow(
        UUID id,
        String producerId,
        ShowStatus status,
        int version,
        Instant updatedAt,
        Instant startsAt,
        Instant salesStartAt,
        Instant salesEndAt,
        boolean highDemand,
        List<CatalogSector> sectors) {

    public record CatalogSector(UUID id, String name, SectorKind kind, int capacity, List<Row> rows,
            List<CatalogLot> lots) {
    }

    /** Uma fileira de cadeira numerada: as cadeiras vão de 1 a {@code seatCount}. */
    public record Row(String label, int seatCount) {
    }

    public record CatalogLot(UUID id, String name, long priceCents, int quantity, Instant opensAt) {
    }
}

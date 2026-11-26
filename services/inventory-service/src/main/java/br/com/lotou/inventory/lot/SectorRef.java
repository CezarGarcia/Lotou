package br.com.lotou.inventory.lot;

import java.util.UUID;

/** Um setor de um show. */
public record SectorRef(UUID showId, UUID sectorId) {
}

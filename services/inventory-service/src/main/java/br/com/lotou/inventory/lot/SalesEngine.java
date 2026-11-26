package br.com.lotou.inventory.lot;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.SectorKind;

/**
 * O ciclo das vendas e a leitura do que está à venda, nos dois motores (Postgres e Redis). Quem
 * decide o motor é {@code lotou.inventory.engine}; o comportamento visto de fora é o mesmo.
 */
public interface SalesEngine {

    /**
     * O que a loja mostra para um setor.
     *
     * @param lot o lote em venda, que define o preço; {@code null} se não há lote em venda
     * @param available ingressos que ainda podem ser reservados no lote em venda
     */
    record SectorAvailability(UUID id, String name, SectorKind kind, int capacity, SectorLots.Sale sale,
            CurrentLot lot, int available) {
    }

    record CurrentLot(UUID id, String name, long priceCents) {
    }

    /** @param available se a cadeira pode ser reservada agora */
    record SeatAvailability(String label, boolean available) {
    }

    record LotView(UUID id, UUID showId, UUID sectorId, String name, long priceCents, int available,
            LotStatus status) {
    }

    /** Abertura das vendas: o primeiro lote de cada setor entra em venda. */
    boolean openSales(UUID showId, Instant now);

    /** Encerramento das vendas: o lote atual de cada setor fecha. */
    boolean closeSales(UUID showId, Instant now);

    /** Virada de lote pela data marcada pelo produtor. */
    boolean turnByDate(SectorRef sector, Instant now);

    LotView pause(UUID lotId, String producerId);

    LotView resume(UUID lotId, String producerId);

    List<SectorAvailability> availability(UUID showId);

    List<SeatAvailability> seats(UUID showId, UUID sectorId);

    /** Manutenção periódica do motor (o Redis recarrega shows que perderam o estoque). */
    void maintain(Instant now);
}

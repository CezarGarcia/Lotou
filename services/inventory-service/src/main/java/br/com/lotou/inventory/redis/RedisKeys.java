package br.com.lotou.inventory.redis;

import java.util.UUID;

/**
 * Nomes das chaves do {@code redis-core}, os mesmos da tabela "Redis" de docs/projeto.md e dos
 * scripts Lua ({@code redis/lib.lua}).
 */
public final class RedisKeys {

    public static final String RESERVATION_STREAM = "stream:reservations";

    private RedisKeys() {
    }

    /** Marca que o estoque do show está carregado; guarda dados do show usados pelos scripts. */
    public static String show(UUID showId) {
        return "show:" + showId;
    }

    /** Status de venda do setor e o lote em venda. */
    public static String sector(UUID showId, UUID sectorId) {
        return "sector:" + showId + ":" + sectorId;
    }

    /** Lotes agendados do setor, em ordem de virada. */
    public static String nextLots(UUID showId, UUID sectorId) {
        return sector(showId, sectorId) + ":next";
    }

    public static String lotStock(UUID lotId) {
        return "lot:" + lotId + ":stock";
    }

    public static String seat(UUID showId, UUID seatId) {
        return "seat:" + showId + ":" + seatId;
    }

    /** Um bit por cadeira do setor: 1 é ocupada (segurada ou vendida). */
    public static String seatMap(UUID showId, UUID sectorId) {
        return "seatmap:" + showId + ":" + sectorId;
    }

    public static String reservation(UUID reservationId) {
        return "res:" + reservationId;
    }

    public static String purchaseLimit(UUID showId, String cpfHash) {
        return "limit:" + showId + ":" + cpfHash;
    }

    public static String queue(UUID showId) {
        return "queue:" + showId;
    }

    public static String waitingRoom(UUID showId) {
        return queue(showId) + ":room";
    }

    public static String queueDrawn(UUID showId) {
        return queue(showId) + ":drawn";
    }

    public static String admitted(UUID showId, String userId) {
        return "admitted:" + showId + ":" + userId;
    }

    public static String lock(String name) {
        return "lock:" + name;
    }

    /** Canal pub/sub das mudanças no mapa de assentos de um show. */
    public static String seatMapChannel(UUID showId) {
        return "seatmap." + showId;
    }
}

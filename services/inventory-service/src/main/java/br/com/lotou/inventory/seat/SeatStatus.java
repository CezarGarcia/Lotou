package br.com.lotou.inventory.seat;

public enum SeatStatus {
    AVAILABLE,
    /** Segurada por uma reserva que ainda não foi paga. */
    HELD,
    SOLD
}

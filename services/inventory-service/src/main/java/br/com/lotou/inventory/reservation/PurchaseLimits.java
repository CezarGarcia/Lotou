package br.com.lotou.inventory.reservation;

import java.util.UUID;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/**
 * Ingressos por CPF em cada show, somando as reservas seguradas e as confirmadas. Reserva
 * expirada, liberada ou reembolsada devolve a cota.
 */
@Repository
public class PurchaseLimits {

    private final JdbcClient jdbc;

    public PurchaseLimits(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * Tenta somar {@code quantity} à cota do CPF, sem passar de {@code max}. É um único comando: o
     * banco confere o limite e incrementa com a linha travada, então duas reservas simultâneas do
     * mesmo CPF não passam juntas do limite.
     *
     * @return se a cota comportou os ingressos
     */
    public boolean tryTake(UUID showId, String cpfHash, int quantity, int max) {
        if (quantity > max) {
            return false;
        }
        return this.jdbc.sql("""
                INSERT INTO purchase_limits AS pl (show_id, cpf_hash, quantity)
                VALUES (:showId, :cpfHash, :quantity)
                ON CONFLICT (show_id, cpf_hash) DO UPDATE
                SET quantity = pl.quantity + EXCLUDED.quantity
                WHERE pl.quantity + EXCLUDED.quantity <= :max
                """)
                .param("showId", showId)
                .param("cpfHash", cpfHash)
                .param("quantity", quantity)
                .param("max", max)
                .update() == 1;
    }

    public void giveBack(UUID showId, String cpfHash, int quantity) {
        this.jdbc.sql("""
                UPDATE purchase_limits SET quantity = GREATEST(quantity - :quantity, 0)
                WHERE show_id = :showId AND cpf_hash = :cpfHash
                """)
                .param("showId", showId)
                .param("cpfHash", cpfHash)
                .param("quantity", quantity)
                .update();
    }

    public int used(UUID showId, String cpfHash) {
        return this.jdbc.sql("SELECT quantity FROM purchase_limits WHERE show_id = :showId AND cpf_hash = :cpfHash")
                .param("showId", showId)
                .param("cpfHash", cpfHash)
                .query(Integer.class)
                .optional()
                .orElse(0);
    }
}

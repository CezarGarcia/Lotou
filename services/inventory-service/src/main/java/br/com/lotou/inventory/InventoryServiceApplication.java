package br.com.lotou.inventory;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/**
 * Lotes, disponibilidade e reservas de pista e de assento.
 *
 * <p>Na fase 1 a reserva usa lock no Postgres ({@code SELECT ... FOR UPDATE}). É a linha de base
 * que a reserva no Redis precisa superar na fase 2 (ADR 3).
 */
@SpringBootApplication
@ConfigurationPropertiesScan
public class InventoryServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(InventoryServiceApplication.class, args);
    }
}

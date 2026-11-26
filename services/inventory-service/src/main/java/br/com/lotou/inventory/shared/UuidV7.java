package br.com.lotou.inventory.shared;

import java.security.SecureRandom;
import java.util.UUID;

/**
 * Gera UUID v7 (RFC 9562): 48 bits de tempo em milissegundos e 74 bits aleatórios. É ordenável por
 * tempo, o que mantém os índices do Postgres compactos, e não revela quantos registros existem.
 */
public final class UuidV7 {

    private static final SecureRandom RANDOM = new SecureRandom();

    private UuidV7() {
    }

    public static UUID generate() {
        long timestamp = System.currentTimeMillis();
        long randomA = RANDOM.nextLong() & 0x0FFFL;
        long randomB = RANDOM.nextLong() & 0x3FFFFFFFFFFFFFFFL;
        long mostSignificant = (timestamp << 16) | 0x7000L | randomA; // versão 7
        long leastSignificant = 0x8000000000000000L | randomB; // variante RFC
        return new UUID(mostSignificant, leastSignificant);
    }
}

package br.com.lotou.inventory.support;

import java.util.concurrent.atomic.AtomicInteger;

/** Gera CPFs válidos e diferentes para os testes (os dígitos verificadores são calculados). */
public final class Cpfs {

    private static final AtomicInteger SEQUENCE = new AtomicInteger(100_000_000);

    private Cpfs() {
    }

    public static String next() {
        String base = String.valueOf(SEQUENCE.incrementAndGet());
        String withFirst = base + checkDigit(base);
        return withFirst + checkDigit(withFirst);
    }

    private static int checkDigit(String digits) {
        int sum = 0;
        for (int i = 0; i < digits.length(); i++) {
            sum += (digits.charAt(i) - '0') * (digits.length() + 1 - i);
        }
        int remainder = (sum * 10) % 11;
        return remainder == 10 ? 0 : remainder;
    }
}

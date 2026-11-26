package br.com.lotou.inventory.shared;

/** Validação de CPF pelos dígitos verificadores. */
public final class Cpf {

    private Cpf() {
    }

    /** Só os 11 dígitos, sem pontuação. */
    public static String digits(String cpf) {
        return cpf == null ? "" : cpf.replaceAll("\\D", "");
    }

    public static boolean isValid(String cpf) {
        String digits = digits(cpf);
        // Sequências como 111.111.111-11 passam na conta, mas não são CPFs.
        if (digits.length() != 11 || digits.chars().distinct().count() == 1) {
            return false;
        }
        return checkDigit(digits, 9) == digits.charAt(9) - '0'
                && checkDigit(digits, 10) == digits.charAt(10) - '0';
    }

    private static int checkDigit(String digits, int length) {
        int sum = 0;
        for (int i = 0; i < length; i++) {
            sum += (digits.charAt(i) - '0') * (length + 1 - i);
        }
        int remainder = (sum * 10) % 11;
        return remainder == 10 ? 0 : remainder;
    }
}

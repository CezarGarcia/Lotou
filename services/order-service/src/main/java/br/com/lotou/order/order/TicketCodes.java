package br.com.lotou.order.order;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Base64;
import java.util.UUID;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import br.com.lotou.order.config.OrderProperties;

import org.springframework.stereotype.Component;

/**
 * O conteúdo do QR code de cada ingresso (ADR 15): {@code LOTOU1.<ticketId>.<assinatura>}, em que a
 * assinatura é o HMAC-SHA256 do prefixo e do ID com uma chave secreta, em base64url sem padding.
 *
 * <p>A portaria confere a assinatura com a mesma chave e recusa um QR falsificado sem consultar
 * banco nenhum. O prefixo versiona o formato: uma troca de chave ou de algoritmo vira LOTOU2.
 */
@Component
public class TicketCodes {

    static final String PREFIX = "LOTOU1.";

    private final SecretKeySpec key;

    public TicketCodes(OrderProperties properties) {
        this.key = new SecretKeySpec(properties.tickets().qrKey().getBytes(StandardCharsets.UTF_8), "HmacSHA256");
    }

    public String codeFor(UUID ticketId) {
        String content = PREFIX + ticketId;
        return content + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(sign(content));
    }

    /** Se o código foi emitido com esta chave. Comparação em tempo constante. */
    public boolean isValid(String code) {
        int dot = code.lastIndexOf('.');
        if (!code.startsWith(PREFIX) || dot <= PREFIX.length()) {
            return false;
        }
        byte[] expected = sign(code.substring(0, dot));
        try {
            byte[] given = Base64.getUrlDecoder().decode(code.substring(dot + 1));
            return java.security.MessageDigest.isEqual(expected, given);
        }
        catch (IllegalArgumentException malformed) {
            return false;
        }
    }

    private byte[] sign(String content) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(this.key);
            return mac.doFinal(content.getBytes(StandardCharsets.UTF_8));
        }
        catch (GeneralSecurityException ex) {
            throw new IllegalStateException("HMAC-SHA256 indisponível", ex);
        }
    }
}

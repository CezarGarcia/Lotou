package br.com.lotou.order.order;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;

import org.springframework.stereotype.Component;

/**
 * O conteúdo do QR code de cada ingresso (ADR 38): {@code LOTOU2.<ticketId>.<assinatura>}, em que a
 * assinatura é Ed25519 de {@code "LOTOU2.<ticketId>"} com a chave privada do order-service, em
 * base64url sem padding (64 bytes, 86 caracteres).
 *
 * <p>A portaria confere com a chave pública, inclusive no aparelho, sem internet: quem tem só a
 * pública confere, mas não consegue criar ingresso. O formato anterior, {@code LOTOU1} com HMAC
 * (ADR 15), continua aceito pela portaria para os ingressos já emitidos. Ed25519 é determinístico:
 * o mesmo ingresso tem sempre o mesmo código.
 */
@Component
public class TicketCodes {

    static final String PREFIX = "LOTOU2.";

    private final PrivateKey key;

    public TicketCodes(OrderProperties properties) {
        this.key = privateKey(properties.tickets().signingKey());
    }

    public String codeFor(UUID ticketId) {
        String content = PREFIX + ticketId;
        return content + "." + Base64.getUrlEncoder().withoutPadding().encodeToString(sign(content));
    }

    private byte[] sign(String content) {
        try {
            Signature signature = Signature.getInstance("Ed25519");
            signature.initSign(this.key);
            signature.update(content.getBytes(StandardCharsets.UTF_8));
            return signature.sign();
        }
        catch (GeneralSecurityException ex) {
            throw new IllegalStateException("Ed25519 indisponível", ex);
        }
    }

    /** A chave privada em PKCS#8 DER, em base64 (como a variável de ambiente a traz). */
    static PrivateKey privateKey(String base64) {
        try {
            byte[] der = Base64.getDecoder().decode(base64.strip());
            return KeyFactory.getInstance("Ed25519").generatePrivate(new PKCS8EncodedKeySpec(der));
        }
        catch (IllegalArgumentException | GeneralSecurityException ex) {
            throw new IllegalStateException("TICKET_SIGNING_KEY não é uma chave privada Ed25519 (PKCS#8 em base64)", ex);
        }
    }
}

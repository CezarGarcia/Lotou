package br.com.lotou.inventory.shared;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.HexFormat;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import br.com.lotou.inventory.config.InventoryProperties;

import org.springframework.stereotype.Component;

/**
 * Transforma o CPF num hash, que é o que o serviço grava e usa para o limite por CPF. O CPF em si
 * não é persistido nem aparece em log.
 *
 * <p>É um HMAC-SHA-256 com chave secreta, não um SHA puro: existem só 10^11 CPFs possíveis, então
 * um hash sem chave seria revertido por força bruta em minutos (ADR 24).
 */
@Component
public class CpfHasher {

    private static final String ALGORITHM = "HmacSHA256";

    private final SecretKeySpec key;

    public CpfHasher(InventoryProperties properties) {
        this.key = new SecretKeySpec(properties.reservation().cpfHashKey().getBytes(StandardCharsets.UTF_8),
                ALGORITHM);
    }

    public String hash(String cpf) {
        try {
            Mac mac = Mac.getInstance(ALGORITHM);
            mac.init(this.key);
            return HexFormat.of().formatHex(mac.doFinal(Cpf.digits(cpf).getBytes(StandardCharsets.UTF_8)));
        }
        catch (GeneralSecurityException ex) {
            throw new IllegalStateException("HMAC-SHA-256 indisponível", ex);
        }
    }
}

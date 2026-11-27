package br.com.lotou.order.order;

import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PublicKey;
import java.security.Signature;
import java.util.Base64;
import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TicketCodesTests {

    private static KeyPair keyPair() throws Exception {
        return KeyPairGenerator.getInstance("Ed25519").generateKeyPair();
    }

    private static TicketCodes withKey(KeyPair pair) {
        String pkcs8 = Base64.getEncoder().encodeToString(pair.getPrivate().getEncoded());
        return new TicketCodes(new OrderProperties(null, null, new OrderProperties.Tickets(pkcs8), null, null));
    }

    /** Como a portaria confere: só com a chave pública. */
    private static boolean verify(PublicKey publicKey, String code) throws Exception {
        int dot = code.lastIndexOf('.');
        Signature signature = Signature.getInstance("Ed25519");
        signature.initVerify(publicKey);
        signature.update(code.substring(0, dot).getBytes(StandardCharsets.UTF_8));
        return signature.verify(Base64.getUrlDecoder().decode(code.substring(dot + 1)));
    }

    @Test
    void codigoTemPrefixoIdEAssinaturaQueAChavePublicaConfere() throws Exception {
        KeyPair pair = keyPair();
        TicketCodes codes = withKey(pair);
        UUID ticket = UUID.randomUUID();

        String code = codes.codeFor(ticket);

        assertThat(code).matches("LOTOU2\\." + ticket + "\\.[A-Za-z0-9_-]{86}");
        assertThat(verify(pair.getPublic(), code)).isTrue();
        // Ed25519 é determinístico: o mesmo ingresso tem sempre o mesmo código.
        assertThat(codes.codeFor(ticket)).isEqualTo(code);
    }

    @Test
    void outroIngressoOuOutraChaveNaoPassamNaConferencia() throws Exception {
        KeyPair pair = keyPair();
        UUID ticket = UUID.randomUUID();
        String code = withKey(pair).codeFor(ticket);

        String otherTicket = code.replace(ticket.toString(), UUID.randomUUID().toString());
        assertThat(verify(pair.getPublic(), otherTicket)).isFalse();
        assertThat(verify(keyPair().getPublic(), code)).isFalse();
    }

    @Test
    void chaveInvalidaFalhaNaSubida() {
        assertThatThrownBy(() -> new TicketCodes(
                new OrderProperties(null, null, new OrderProperties.Tickets("nao-e-uma-chave"), null, null)))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("TICKET_SIGNING_KEY");
    }
}

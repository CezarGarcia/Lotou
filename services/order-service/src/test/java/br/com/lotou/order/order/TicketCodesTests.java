package br.com.lotou.order.order;

import java.util.UUID;

import br.com.lotou.order.config.OrderProperties;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class TicketCodesTests {

    private static TicketCodes withKey(String key) {
        return new TicketCodes(new OrderProperties(null, null, new OrderProperties.Tickets(key), null, null));
    }

    @Test
    void codigoTemPrefixoIdEAssinaturaEPassaNaConferencia() {
        TicketCodes codes = withKey("chave-de-teste");
        UUID ticket = UUID.randomUUID();

        String code = codes.codeFor(ticket);

        assertThat(code).matches("LOTOU1\\." + ticket + "\\.[A-Za-z0-9_-]{43}");
        assertThat(codes.isValid(code)).isTrue();
        // Determinístico: o mesmo ingresso tem sempre o mesmo código.
        assertThat(codes.codeFor(ticket)).isEqualTo(code);
    }

    @Test
    void recusaCodigoAlteradoOuAssinadoComOutraChave() {
        TicketCodes codes = withKey("chave-de-teste");
        UUID ticket = UUID.randomUUID();
        String code = codes.codeFor(ticket);

        String otherTicket = code.replace(ticket.toString(), UUID.randomUUID().toString());
        assertThat(codes.isValid(otherTicket)).isFalse();
        assertThat(withKey("outra-chave").isValid(code)).isFalse();
        assertThat(codes.isValid("LOTOU1." + ticket + ".nao-e-base64!")).isFalse();
        assertThat(codes.isValid("qualquer coisa")).isFalse();
    }
}

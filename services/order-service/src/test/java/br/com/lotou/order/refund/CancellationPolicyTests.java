package br.com.lotou.order.refund;

import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

import br.com.lotou.order.catalog.LocalShow;
import br.com.lotou.order.order.Order;
import br.com.lotou.order.order.OrderStatus;
import br.com.lotou.order.pricing.ServiceFeePayer;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class CancellationPolicyTests {

    private static final Instant CONFIRMED_AT = Instant.parse("2026-11-20T12:00:00Z");

    @Test
    void podeCancelarAteSeteDiasDepoisDaCompra() {
        LocalShow show = show(CONFIRMED_AT.plus(Duration.ofDays(30)), "ON_SALE");
        var decision = CancellationPolicy.decide(confirmed(false), show, CONFIRMED_AT.plus(Duration.ofDays(6)));
        assertThat(decision.allowed()).isTrue();
        assertThat(decision.deadline()).isEqualTo(CONFIRMED_AT.plus(Duration.ofDays(7)));

        var late = CancellationPolicy.decide(confirmed(false), show, CONFIRMED_AT.plus(Duration.ofDays(7)).plusMillis(1));
        assertThat(late.allowed()).isFalse();
        assertThat(late.reason()).isEqualTo(CancellationPolicy.Refusal.WINDOW_EXPIRED);
    }

    @Test
    void showMuitoPertoEncurtaOPrazo() {
        Instant startsAt = CONFIRMED_AT.plus(Duration.ofDays(3));
        LocalShow show = show(startsAt, "ON_SALE");
        var decision = CancellationPolicy.decide(confirmed(false), show, CONFIRMED_AT.plus(Duration.ofHours(1)));
        assertThat(decision.allowed()).isTrue();
        assertThat(decision.deadline()).isEqualTo(startsAt.minus(Duration.ofHours(48)));

        var tooClose = CancellationPolicy.decide(confirmed(false), show, startsAt.minus(Duration.ofHours(47)));
        assertThat(tooClose.reason()).isEqualTo(CancellationPolicy.Refusal.TOO_CLOSE_TO_SHOW);
    }

    @Test
    void ingressoUsadoOuPedidoNaoConfirmadoNaoCancela() {
        LocalShow show = show(CONFIRMED_AT.plus(Duration.ofDays(30)), "ON_SALE");
        assertThat(CancellationPolicy.decide(confirmed(true), show, CONFIRMED_AT).reason())
                .isEqualTo(CancellationPolicy.Refusal.TICKET_USED);
        Order pending = mock(Order.class);
        when(pending.is(OrderStatus.CONFIRMED)).thenReturn(false);
        assertThat(CancellationPolicy.decide(pending, show, CONFIRMED_AT).reason())
                .isEqualTo(CancellationPolicy.Refusal.NOT_CONFIRMED);
    }

    @Test
    void showCanceladoSemprePermite() {
        LocalShow show = show(CONFIRMED_AT.plus(Duration.ofDays(1)), "CANCELLED");
        var decision = CancellationPolicy.decide(confirmed(false), show, CONFIRMED_AT.plus(Duration.ofDays(20)));
        assertThat(decision.allowed()).isTrue();
    }

    private static Order confirmed(boolean usedTicket) {
        Order order = mock(Order.class);
        when(order.is(OrderStatus.CONFIRMED)).thenReturn(true);
        when(order.getConfirmedAt()).thenReturn(CONFIRMED_AT);
        when(order.hasUsedTicket()).thenReturn(usedTicket);
        return order;
    }

    private static LocalShow show(Instant startsAt, String status) {
        return new LocalShow(UUID.randomUUID(), "produtor", status, "Show", startsAt, ServiceFeePayer.BUYER, 2);
    }
}

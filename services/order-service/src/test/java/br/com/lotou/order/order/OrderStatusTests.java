package br.com.lotou.order.order;

import static br.com.lotou.order.order.OrderStatus.CANCELLED;
import static br.com.lotou.order.order.OrderStatus.CONFIRMED;
import static br.com.lotou.order.order.OrderStatus.PENDING;
import static br.com.lotou.order.order.OrderStatus.REFUNDED;
import static br.com.lotou.order.order.OrderStatus.REFUNDING;
import static br.com.lotou.order.order.OrderStatus.REFUND_FAILED;
import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;

class OrderStatusTests {

    /** A tabela de transições do pedido, como está em docs/projeto.md. */
    private static final Map<OrderStatus, Set<OrderStatus>> ORDERS = Map.of(
            PENDING, Set.of(CONFIRMED, CANCELLED),
            CONFIRMED, Set.of(REFUNDING),
            REFUNDING, Set.of(REFUNDED, REFUND_FAILED),
            REFUND_FAILED, Set.of(REFUNDING),
            CANCELLED, Set.of(),
            REFUNDED, Set.of());

    @Test
    void pedidoSoPermiteAsTransicoesDaTabela() {
        for (OrderStatus from : OrderStatus.values()) {
            for (OrderStatus to : OrderStatus.values()) {
                assertThat(from.canTransitionTo(to))
                        .as("%s -> %s", from, to)
                        .isEqualTo(ORDERS.get(from).contains(to));
            }
        }
    }

    @Test
    void ingressoValidoPodeSerUsadoOuCanceladoEOsOutrosEstadosSaoFinais() {
        assertThat(TicketStatus.VALID.canTransitionTo(TicketStatus.USED)).isTrue();
        assertThat(TicketStatus.VALID.canTransitionTo(TicketStatus.CANCELLED)).isTrue();
        assertThat(TicketStatus.VALID.canTransitionTo(TicketStatus.VALID)).isFalse();
        for (TicketStatus to : TicketStatus.values()) {
            assertThat(TicketStatus.USED.canTransitionTo(to)).isFalse();
            assertThat(TicketStatus.CANCELLED.canTransitionTo(to)).isFalse();
        }
    }
}

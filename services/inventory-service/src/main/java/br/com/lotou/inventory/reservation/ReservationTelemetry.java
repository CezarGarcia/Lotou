package br.com.lotou.inventory.reservation;

import br.com.lotou.inventory.catalog.SectorKind;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.Meter;

import org.springframework.stereotype.Component;

/**
 * Métricas de negócio da reserva (seção "Métricas de negócio" de docs/projeto.md). Usa a API do
 * OpenTelemetry; quem exporta é o Java agent. Sem o agent (testes), não faz nada.
 */
@Component
public class ReservationTelemetry {

    private static final AttributeKey<String> TYPE = AttributeKey.stringKey("type");
    private static final AttributeKey<String> RESULT = AttributeKey.stringKey("result");

    private final LongCounter reservations;
    private final LongCounter seatConflicts;

    public ReservationTelemetry() {
        Meter meter = GlobalOpenTelemetry.getMeter("lotou.inventory");
        this.reservations = meter.counterBuilder("ticket_reservations_total")
                .setDescription("Tentativas de reserva, por tipo de setor e resultado")
                .build();
        this.seatConflicts = meter.counterBuilder("seat_hold_conflicts_total")
                .setDescription("Reservas recusadas porque a cadeira já estava ocupada")
                .build();
    }

    /** @param result {@code reserved} ou o tipo do problema, ex.: {@code sold-out} */
    void reservation(SectorKind kind, String result) {
        this.reservations.add(1, Attributes.of(TYPE, kind == SectorKind.RESERVED_SEATING ? "seat" : "general",
                RESULT, result));
    }

    /** Duas pessoas tentaram a mesma cadeira; a segunda perdeu. */
    void seatConflict() {
        this.seatConflicts.add(1);
    }
}

package br.com.lotou.inventory.support;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.atomic.AtomicReference;

/** Um relógio que os testes adiantam, para expirar reservas e abrir vendas sem esperar. */
public class MutableClock extends Clock {

    private final AtomicReference<Duration> offset = new AtomicReference<>(Duration.ZERO);

    public void advance(Duration duration) {
        this.offset.updateAndGet(current -> current.plus(duration));
    }

    public void reset() {
        this.offset.set(Duration.ZERO);
    }

    @Override
    public Instant instant() {
        return Instant.now().plus(this.offset.get());
    }

    @Override
    public ZoneId getZone() {
        return ZoneOffset.UTC;
    }

    @Override
    public Clock withZone(ZoneId zone) {
        return this;
    }
}

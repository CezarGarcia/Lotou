package br.com.lotou.inventory.queue;

import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import br.com.lotou.inventory.config.InventoryProperties;
import br.com.lotou.inventory.redis.LuaScripts;
import br.com.lotou.inventory.redis.RedisKeys;
import br.com.lotou.inventory.redis.RedisLock;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.DoubleHistogram;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.Meter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * A cada segundo, para cada show de alta demanda com as vendas abertas:
 *
 * <ol>
 *   <li>sorteia a sala de espera, uma vez, na abertura;
 *   <li>admite os próximos N da fila ({@code ZPOPMIN}), cada um com um token de 5 minutos.
 * </ol>
 *
 * <p>Os dois passos rodam sob lock distribuído, para várias instâncias não admitirem 2N por
 * segundo; o sorteio também confere dentro do script se já foi feito.
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class QueueAdmissionJob {

    private static final Logger log = LoggerFactory.getLogger(QueueAdmissionJob.class);
    private static final AttributeKey<String> SHOW = AttributeKey.stringKey("show_id");
    /** Scores acima disso são horas de chegada (ms); abaixo, posições sorteadas da sala de espera. */
    private static final double ARRIVAL_TIME_SCORE = 1e12;

    private final JdbcClient jdbc;
    private final StringRedisTemplate redis;
    private final LuaScripts scripts;
    private final RedisLock lock;
    private final InventoryProperties.Queue config;
    private final Clock clock;
    private final SecureRandom random = new SecureRandom();
    private final Map<UUID, Long> lengths = new ConcurrentHashMap<>();
    private final LongCounter admitted;
    private final DoubleHistogram waitSeconds;

    public QueueAdmissionJob(JdbcClient jdbc, StringRedisTemplate redis, LuaScripts scripts, RedisLock lock,
            InventoryProperties properties, Clock clock) {
        this.jdbc = jdbc;
        this.redis = redis;
        this.scripts = scripts;
        this.lock = lock;
        this.config = properties.queue();
        this.clock = clock;
        Meter meter = GlobalOpenTelemetry.getMeter("lotou.inventory");
        this.admitted = meter.counterBuilder("queue_admitted_total")
                .setDescription("Compradores admitidos pela fila virtual")
                .build();
        this.waitSeconds = meter.histogramBuilder("queue_wait_seconds")
                .setDescription("Espera na fila, da chegada à admissão (quem chegou depois da abertura)")
                .setUnit("s")
                .build();
        meter.gaugeBuilder("queue_length").ofLongs()
                .setDescription("Pessoas na fila virtual, por show")
                .buildWithCallback(measurement -> this.lengths.forEach((show, length) ->
                        measurement.record(length, Attributes.of(SHOW, show.toString()))));
    }

    @Scheduled(fixedDelayString = "${lotou.inventory.jobs.queue-interval:1s}")
    public void run() {
        for (UUID showId : openHighDemandShows()) {
            try {
                drawIfNeeded(showId);
                admitNext(showId);
            }
            catch (RuntimeException ex) {
                log.error("Falha na fila virtual do show {}", showId, ex);
            }
        }
    }

    /** Sorteio da sala de espera: posições embaralhadas com {@link SecureRandom}, à frente de quem chegar depois. */
    public void drawIfNeeded(UUID showId) {
        if (Boolean.TRUE.equals(this.redis.hasKey(RedisKeys.queueDrawn(showId)))) {
            return;
        }
        Optional<RedisLock.Lease> lease = this.lock.tryAcquire("queue-draw:" + showId, Duration.ofSeconds(30));
        if (lease.isEmpty()) {
            return;
        }
        try (RedisLock.Lease ignored = lease.get()) {
            Set<String> room = this.redis.opsForSet().members(RedisKeys.waitingRoom(showId));
            List<String> order = new ArrayList<>(room == null ? Set.of() : room);
            Collections.shuffle(order, this.random);
            List<Object> args = new ArrayList<>();
            args.add(showId);
            args.addAll(order);
            LuaScripts.Result result = this.scripts.run("queue-draw", args.toArray());
            log.info("Sala de espera do show {} sorteada: {} pessoas", showId, result.code());
        }
    }

    /** Admite os próximos N. Devolve quantos foram admitidos. */
    public int admitNext(UUID showId) {
        Optional<RedisLock.Lease> lease = this.lock.tryAcquire("queue-admit:" + showId, Duration.ofMillis(900));
        if (lease.isEmpty()) {
            return 0;
        }
        // O lock não é solto: ele dura quase um segundo e garante uma admissão por segundo, mesmo
        // com várias instâncias rodando o job.
        LuaScripts.Result popped = this.scripts.run("queue-admit", showId, this.config.admissionRate(),
                this.config.admissionTtl().toMillis());
        long now = this.clock.millis();
        int count = popped.values().size() / 2;
        for (int i = 1; i < popped.values().size(); i += 2) {
            double score = Double.parseDouble(popped.values().get(i));
            if (score > ARRIVAL_TIME_SCORE) {
                this.waitSeconds.record((now - score) / 1000.0);
            }
        }
        if (count > 0) {
            this.admitted.add(count, Attributes.of(SHOW, showId.toString()));
        }
        Long length = this.redis.opsForZSet().zCard(RedisKeys.queue(showId));
        this.lengths.put(showId, length == null ? 0 : length);
        return count;
    }

    private List<UUID> openHighDemandShows() {
        return this.jdbc.sql("""
                SELECT id FROM shows
                WHERE high_demand AND sales_opened_at IS NOT NULL AND sales_closed_at IS NULL
                """).query(UUID.class).list();
    }
}

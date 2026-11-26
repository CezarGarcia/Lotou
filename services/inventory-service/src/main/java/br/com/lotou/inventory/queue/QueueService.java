package br.com.lotou.inventory.queue;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import br.com.lotou.inventory.catalog.Show;
import br.com.lotou.inventory.catalog.ShowRepository;
import br.com.lotou.inventory.config.InventoryProperties;
import br.com.lotou.inventory.queue.QueueStatus.State;
import br.com.lotou.inventory.redis.LuaScripts;
import br.com.lotou.inventory.redis.RedisKeys;
import br.com.lotou.inventory.shared.problem.Problems;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

/**
 * Fila virtual dos shows de alta demanda (Fluxo A de docs/projeto.md).
 *
 * <p>A sala de espera abre 30 minutos antes das vendas. Na abertura, quem estava na sala recebe uma
 * posição sorteada; quem chega depois entra no fim da fila. A cada segundo, o
 * {@link QueueAdmissionJob} admite os próximos N, e cada admitido tem 5 minutos para reservar. A
 * fila vale durante toda a venda de um show de alta demanda: com pouca gente, a admissão é
 * imediata (ADR 13).
 */
@Service
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class QueueService {

    /** O que a fila precisa saber do show. Muda pouco: fica alguns segundos em memória. */
    record ShowInfo(boolean highDemand, Instant salesStartAt, Instant salesEndAt, boolean salesClosed,
            Instant waitingRoomOpensAt, Instant readAt) {
    }

    private static final Duration SHOW_INFO_TTL = Duration.ofSeconds(5);

    private final LuaScripts scripts;
    private final StringRedisTemplate redis;
    private final ShowRepository shows;
    private final InventoryProperties.Queue config;
    private final Clock clock;
    private final Map<UUID, ShowInfo> showInfo = new ConcurrentHashMap<>();

    public QueueService(LuaScripts scripts, StringRedisTemplate redis, ShowRepository shows,
            InventoryProperties properties, Clock clock) {
        this.scripts = scripts;
        this.redis = redis;
        this.shows = shows;
        this.config = properties.queue();
        this.clock = clock;
    }

    /** Entra na fila (ou na sala de espera). Entrar de novo não muda a posição. */
    public QueueStatus join(UUID showId, String userId) {
        ShowInfo show = show(showId);
        Instant now = this.clock.instant();
        State gate = gate(show, now);
        if (gate != null) {
            return QueueStatus.of(showId, gate, show);
        }
        LuaScripts.Result result = this.scripts.run("queue-join", showId, userId, now.toEpochMilli(),
                show.salesStartAt().toEpochMilli());
        return switch (result.code()) {
            case "ADMITTED" -> admitted(showId, show, now, Long.parseLong(result.value(1)));
            case "WAITING_ROOM" -> QueueStatus.of(showId, State.WAITING_ROOM, show);
            case "QUEUED" -> queued(showId, show, Long.parseLong(result.value(1)));
            default -> throw new IllegalStateException("Resultado inesperado do queue-join.lua: " + result.values());
        };
    }

    /** Onde o comprador está, sem entrar na fila. */
    public QueueStatus status(UUID showId, String userId) {
        ShowInfo show = show(showId);
        Instant now = this.clock.instant();
        State gate = gate(show, now);
        if (gate != null) {
            return QueueStatus.of(showId, gate, show);
        }
        Long ttl = this.redis.getExpire(RedisKeys.admitted(showId, userId), java.util.concurrent.TimeUnit.MILLISECONDS);
        if (ttl != null && ttl > 0) {
            return admitted(showId, show, now, ttl);
        }
        if (Boolean.TRUE.equals(this.redis.opsForSet().isMember(RedisKeys.waitingRoom(showId), userId))) {
            return QueueStatus.of(showId, State.WAITING_ROOM, show);
        }
        Long rank = this.redis.opsForZSet().rank(RedisKeys.queue(showId), userId);
        return rank == null ? QueueStatus.of(showId, State.NOT_IN_QUEUE, show) : queued(showId, show, rank + 1);
    }

    /** Situações em que a fila nem é consultada. */
    private State gate(ShowInfo show, Instant now) {
        if (!show.highDemand()) {
            return State.NOT_REQUIRED;
        }
        if (show.salesClosed() || (show.salesEndAt() != null && !now.isBefore(show.salesEndAt()))) {
            return State.CLOSED;
        }
        if (show.salesStartAt() == null || now.isBefore(show.waitingRoomOpensAt())) {
            return State.NOT_OPEN;
        }
        return null;
    }

    private QueueStatus queued(UUID showId, ShowInfo show, long position) {
        long waitSeconds = (position + this.config.admissionRate() - 1) / this.config.admissionRate();
        return new QueueStatus(showId, State.QUEUED, position, waitSeconds, null, show.salesStartAt(),
                show.waitingRoomOpensAt());
    }

    private static QueueStatus admitted(UUID showId, ShowInfo show, Instant now, long ttlMillis) {
        return new QueueStatus(showId, State.ADMITTED, null, null, now.plusMillis(ttlMillis), show.salesStartAt(),
                show.waitingRoomOpensAt());
    }

    ShowInfo show(UUID showId) {
        Instant now = this.clock.instant();
        ShowInfo cached = this.showInfo.get(showId);
        if (cached != null && cached.readAt().plus(SHOW_INFO_TTL).isAfter(now)) {
            return cached;
        }
        Show show = this.shows.findById(showId).orElseThrow(() -> Problems.notFound("Show"));
        Instant salesStart = show.getSalesStartAt();
        ShowInfo fresh = new ShowInfo(show.isHighDemand(), salesStart, show.getSalesEndAt(), show.salesClosed(),
                salesStart == null ? null : salesStart.minus(this.config.waitingRoomOpensBefore()), now);
        this.showInfo.put(showId, fresh);
        return fresh;
    }
}

package br.com.lotou.inventory.reservation;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.inventory.catalog.CatalogCache;
import br.com.lotou.inventory.catalog.CatalogCache.LotInfo;
import br.com.lotou.inventory.catalog.CatalogCache.SeatInfo;
import br.com.lotou.inventory.catalog.ShowRepository;
import br.com.lotou.inventory.config.InventoryProperties;
import br.com.lotou.inventory.redis.InventoryLoader;
import br.com.lotou.inventory.redis.LuaScripts;
import br.com.lotou.inventory.redis.RedisKeys;
import br.com.lotou.inventory.shared.UuidV7;
import br.com.lotou.inventory.shared.problem.InventoryProblems;
import br.com.lotou.inventory.shared.problem.Problems;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Reserva com script Lua no {@code redis-core} (fase 2).
 *
 * <p>O script {@code reserve.lua} confere idempotência, fila virtual, limite do CPF, situação do
 * setor, estoque do lote e cadeiras, e só então muda alguma coisa. O Redis roda um script por vez,
 * então a reserva é atômica sem lock: duas pessoas pela mesma cadeira nunca passam juntas.
 *
 * <p>Na mesma operação atômica, o script grava a mudança em {@code stream:reservations}. O
 * {@code ReservationProjection} consome o stream e grava no Postgres, que fica sendo a cópia
 * durável. O comprador recebe a resposta sem esperar o Postgres (ADR 26).
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class RedisReservationEngine implements ReservationEngine {

    private static final Logger log = LoggerFactory.getLogger(RedisReservationEngine.class);
    /** Por quanto tempo uma {@code Idempotency-Key} devolve a mesma reserva. */
    private static final Duration IDEMPOTENCY_TTL = Duration.ofHours(24);

    private final LuaScripts scripts;
    private final StringRedisTemplate redis;
    private final CatalogCache catalog;
    private final ReservationRepository reservations;
    private final ShowRepository shows;
    private final TransactionTemplate readOnly;
    private final InventoryProperties.Reservation config;
    private final Clock clock;

    public RedisReservationEngine(LuaScripts scripts, StringRedisTemplate redis, CatalogCache catalog,
            ReservationRepository reservations, ShowRepository shows, PlatformTransactionManager transactionManager,
            InventoryProperties properties, Clock clock) {
        this.scripts = scripts;
        this.redis = redis;
        this.catalog = catalog;
        this.reservations = reservations;
        this.shows = shows;
        this.readOnly = new TransactionTemplate(transactionManager);
        this.readOnly.setReadOnly(true);
        this.config = properties.reservation();
        this.clock = clock;
    }

    @Override
    public Held hold(HoldCommand command) {
        UUID showId = command.sector().getShowId();
        UUID sectorId = command.sector().getId();
        List<SeatInfo> seats = resolveSeats(showId, sectorId, command.seats());

        UUID reservationId = UuidV7.generate();
        long now = this.clock.millis();
        List<Object> args = new ArrayList<>(List.of(showId, sectorId, reservationId, command.buyerId(),
                command.cpfHash(), command.quantity(), this.config.maxTicketsPerCpf(), now,
                this.config.ttl().toMillis(), idempotencyKey(command), command.idempotencyKey(),
                command.requestHash(), IDEMPOTENCY_TTL.toMillis(), seats.size()));
        seats.forEach(seat -> args.add(seat.id()));
        seats.forEach(seat -> args.add(seat.position()));
        seats.forEach(seat -> args.add(seat.label()));

        LuaScripts.Result result = this.scripts.run("reserve", args.toArray());
        return switch (result.code()) {
            case "OK" -> new Held(heldView(reservationId, command, seats, UUID.fromString(result.value(1)),
                    Instant.ofEpochMilli(now), Instant.ofEpochMilli(Long.parseLong(result.value(2)))), false);
            case "REPLAY" -> new Held(find(UUID.fromString(result.value(1)))
                    .orElseThrow(() -> new IllegalStateException("Reserva da Idempotency-Key sumiu")), true);
            case "IDEMPOTENCY_KEY_REUSED" -> throw InventoryProblems.idempotencyKeyReused();
            case "NOT_LOADED" -> throw notLoaded(showId);
            case "NOT_ADMITTED" -> throw InventoryProblems.queueAdmissionRequired();
            case "PURCHASE_LIMIT_EXCEEDED" -> throw InventoryProblems.purchaseLimitExceeded(
                    this.config.maxTicketsPerCpf(), Integer.parseInt(result.value(1)));
            case "SECTOR_NOT_FOUND" -> throw Problems.notFound("Setor");
            case "NOT_OPEN" -> throw InventoryProblems.salesNotOpen();
            case "PAUSED" -> throw InventoryProblems.salesPaused();
            case "SOLD_OUT" -> throw InventoryProblems.soldOut();
            case "CLOSED" -> throw InventoryProblems.salesClosed();
            case "INSUFFICIENT_STOCK" -> throw InventoryProblems.insufficientStock(Integer.parseInt(result.value(1)));
            case "SEAT_UNAVAILABLE" -> throw InventoryProblems.seatUnavailable(
                    Arrays.stream(result.value(1).split(",")).sorted().toList());
            default -> throw new IllegalStateException("Resultado inesperado do reserve.lua: " + result.values());
        };
    }

    /** As cadeiras pedidas, na ordem do mapa. Cadeira que não existe no setor é recusada antes do Redis. */
    private List<SeatInfo> resolveSeats(UUID showId, UUID sectorId, List<String> labels) {
        if (labels.isEmpty()) {
            return List.of();
        }
        Map<String, SeatInfo> known = this.catalog.seats(showId, sectorId);
        List<String> missing = labels.stream().filter(label -> !known.containsKey(label)).toList();
        if (!missing.isEmpty()) {
            throw InventoryProblems.seatNotFound(missing);
        }
        return labels.stream().map(known::get).sorted(Comparator.comparingInt(SeatInfo::position)).toList();
    }

    /** A chave Redis de idempotência: por comprador, e sem a chave do cliente em texto. */
    private static String idempotencyKey(HoldCommand command) {
        return InventoryLoader.idempotencyKey(command.buyerId(), command.idempotencyKey());
    }

    /** O estoque não está no Redis: ou as vendas não abriram, ou estão sendo carregadas agora. */
    private RuntimeException notLoaded(UUID showId) {
        boolean opened = this.readOnly.execute(status -> this.shows.findById(showId)
                .map(show -> show.salesOpened() && !show.salesClosed())
                .orElse(false));
        return opened ? InventoryProblems.inventoryLoading() : InventoryProblems.salesNotOpen();
    }

    private ReservationView heldView(UUID id, HoldCommand command, List<SeatInfo> seats, UUID lotId,
            Instant createdAt, Instant expiresAt) {
        LotInfo lot = this.catalog.lot(lotId);
        List<String> labels = seats.stream().map(SeatInfo::label).toList();
        return new ReservationView(id, ReservationStatus.HELD, command.sector().getShowId(),
                command.sector().getId(), command.buyerId(), command.quantity(),
                Math.multiplyExact(lot.priceCents(), command.quantity()), expiresAt, createdAt,
                items(lot, command.quantity(), labels));
    }

    private static List<ReservationView.Item> items(LotInfo lot, int quantity, List<String> labels) {
        List<ReservationView.Item> items = new ArrayList<>();
        for (int i = 0; i < quantity; i++) {
            items.add(new ReservationView.Item(lot.id(), lot.name(), labels.isEmpty() ? null : labels.get(i),
                    lot.priceCents()));
        }
        return items;
    }

    /**
     * Enquanto existe, o hash {@code res:{id}} é a fonte da verdade: o Postgres recebe as mudanças
     * pelo stream, alguns milissegundos depois. Depois que o hash some, vale o Postgres.
     */
    @Override
    public Optional<ReservationView> find(UUID id) {
        Map<Object, Object> hash = this.redis.opsForHash().entries(RedisKeys.reservation(id));
        if (!hash.isEmpty()) {
            return Optional.of(fromHash(id, hash));
        }
        return this.readOnly.execute(status -> this.reservations.findById(id).map(ReservationView::of));
    }

    private ReservationView fromHash(UUID id, Map<Object, Object> hash) {
        LotInfo lot = this.catalog.lot(UUID.fromString(field(hash, "lot")));
        int quantity = Integer.parseInt(field(hash, "qty"));
        String labels = field(hash, "labels");
        return new ReservationView(id, ReservationStatus.valueOf(field(hash, "status")),
                UUID.fromString(field(hash, "show")), UUID.fromString(field(hash, "sector")), field(hash, "buyer"),
                quantity, Math.multiplyExact(lot.priceCents(), quantity),
                Instant.ofEpochMilli(Long.parseLong(field(hash, "expiresAt"))),
                Instant.ofEpochMilli(Long.parseLong(field(hash, "createdAt"))),
                items(lot, quantity, labels.isEmpty() ? List.of() : List.of(labels.split(","))));
    }

    private static String field(Map<Object, Object> hash, String name) {
        Object value = hash.get(name);
        return value == null ? "" : value.toString();
    }

    @Override
    public ReservationView confirm(UUID id) {
        LuaScripts.Result result = this.scripts.run("confirm", id, this.clock.millis());
        return settle(id, result, ReservationStatus.CONFIRMED);
    }

    @Override
    public ReservationView release(UUID id) {
        LuaScripts.Result result = this.scripts.run("release", id, ReservationStatus.RELEASED, this.clock.millis(), 0);
        return settle(id, result, ReservationStatus.RELEASED);
    }

    @Override
    public boolean expire(UUID id) {
        LuaScripts.Result result = this.scripts.run("release", id, ReservationStatus.EXPIRED, this.clock.millis(), 1);
        if (result.is("NOT_FOUND")) {
            log.warn("Reserva {} vencida no Postgres não existe no Redis; a carga do estoque reconcilia", id);
        }
        return result.is("OK");
    }

    /** Traduz o resultado de confirmar ou liberar: idempotente quando a reserva já está no estado pedido. */
    private ReservationView settle(UUID id, LuaScripts.Result result, ReservationStatus target) {
        return switch (result.code()) {
            case "OK", "ALREADY" -> find(id).orElseThrow(() -> Problems.notFound("Reserva"));
            case "NOT_HELD" -> throw InventoryProblems.reservationNotHeld(ReservationStatus.valueOf(result.value(1)));
            // A reserva já saiu do Redis (concluída há mais de um dia): vale o Postgres.
            case "NOT_FOUND" -> {
                ReservationView stored = find(id).orElseThrow(() -> Problems.notFound("Reserva"));
                if (stored.status() != target) {
                    throw InventoryProblems.reservationNotHeld(stored.status());
                }
                yield stored;
            }
            default -> throw new IllegalStateException("Resultado inesperado: " + result.values());
        };
    }
}

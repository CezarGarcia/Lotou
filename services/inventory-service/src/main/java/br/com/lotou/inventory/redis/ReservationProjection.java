package br.com.lotou.inventory.redis;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.metrics.LongCounter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.json.JsonMapper;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.SmartLifecycle;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Range;
import org.springframework.data.redis.RedisSystemException;
import org.springframework.data.redis.connection.stream.Consumer;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.PendingMessage;
import org.springframework.data.redis.connection.stream.PendingMessages;
import org.springframework.data.redis.connection.stream.ReadOffset;
import org.springframework.data.redis.connection.stream.RecordId;
import org.springframework.data.redis.connection.stream.StreamOffset;
import org.springframework.data.redis.connection.stream.StreamReadOptions;
import org.springframework.data.redis.core.StreamOperations;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Grava no Postgres o que o motor Redis mudou: consome {@code stream:reservations} com um consumer
 * group e aplica cada entrada numa transação.
 *
 * <ul>
 *   <li>Uma entrada só é confirmada ({@code XACK}) depois de gravada. Se a instância cair no meio,
 *       a entrada fica pendente e outra instância a assume ({@code XPENDING} + {@code XCLAIM}).
 *   <li>Aplicar a mesma entrada duas vezes não muda nada: cada linha guarda a posição da entrada que
 *       a gravou ({@code redis_seq}), e uma entrada mais antiga nunca sobrescreve uma mais nova.
 *   <li>O stream é aparado só até a entrada mais antiga ainda não confirmada: nada é descartado
 *       antes de chegar ao Postgres.
 * </ul>
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "redis", matchIfMissing = true)
public class ReservationProjection implements SmartLifecycle {

    static final String GROUP = "inventory-projection";

    private static final Logger log = LoggerFactory.getLogger(ReservationProjection.class);
    private static final int BATCH = 200;
    /** Espera entre leituras quando o stream está em dia. */
    private static final Duration IDLE_POLL = Duration.ofMillis(20);
    /** Entrada pendente há mais que isso é de uma instância que caiu: outra assume. */
    private static final Duration ABANDONED_AFTER = Duration.ofSeconds(30);

    /** O que o script Lua grava no stream ({@code redis/lib.lua}). */
    record Entry(String type, ReservationPayload reservation, List<LotState> lots, String seats, String seatStatus,
            Integer limit) {
    }

    record ReservationPayload(UUID id, String status, String buyer, UUID show, UUID sector, String cpf, int qty,
            UUID lot, String seats, long expiresAt, long createdAt, long updatedAt, String idempotencyKey,
            String requestHash) {
    }

    record LotState(UUID id, int available, String status) {
    }

    private final StringRedisTemplate redis;
    private final StreamOperations<String, Object, Object> streams;
    private final JdbcClient jdbc;
    private final TransactionTemplate transaction;
    private final JsonMapper json = JsonMapper.builder()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .build();
    private final String consumerName = "inventory-" + UUID.randomUUID();
    private final AtomicBoolean running = new AtomicBoolean();
    private final LongCounter applied;
    private Thread worker;

    public ReservationProjection(StringRedisTemplate redis, JdbcClient jdbc,
            PlatformTransactionManager transactionManager) {
        this.redis = redis;
        this.streams = redis.opsForStream();
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        this.applied = GlobalOpenTelemetry.getMeter("lotou.inventory").counterBuilder("reservation_stream_applied_total")
                .setDescription("Entradas do stream de reservas gravadas no Postgres")
                .build();
    }

    @Override
    public void start() {
        this.running.set(true);
        this.worker = Thread.ofVirtual().name("reservation-projection").start(this::consume);
    }

    @Override
    public void stop() {
        this.running.set(false);
        if (this.worker != null) {
            this.worker.interrupt();
        }
    }

    @Override
    public boolean isRunning() {
        return this.running.get();
    }

    private void consume() {
        ensureGroup();
        while (this.running.get()) {
            try {
                // Sem BLOCK de propósito: um XREADGROUP bloqueante ocuparia a conexão do Lettuce, que é
                // compartilhada com as reservas, e cada script esperaria a leitura terminar.
                List<MapRecord<String, Object, Object>> records = this.streams.read(
                        Consumer.from(GROUP, this.consumerName),
                        StreamReadOptions.empty().count(BATCH),
                        StreamOffset.create(RedisKeys.RESERVATION_STREAM, ReadOffset.lastConsumed()));
                if (records != null && !records.isEmpty()) {
                    applyAndAck(records);
                }
                else {
                    Thread.sleep(IDLE_POLL.toMillis());
                }
            }
            catch (RedisSystemException ex) {
                if (!this.running.get()) {
                    return;
                }
                if (String.valueOf(ex.getMostSpecificCause().getMessage()).contains("NOGROUP")) {
                    // O Redis perdeu os dados (ou é a primeira subida): o grupo é recriado.
                    ensureGroup();
                }
                else {
                    pause("Falha ao ler o stream de reservas", ex);
                }
            }
            catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
                return;
            }
            catch (RuntimeException ex) {
                if (!this.running.get()) {
                    return;
                }
                pause("Falha ao gravar entradas do stream de reservas", ex);
            }
        }
    }

    /**
     * Assume as entradas que outra instância leu e não confirmou (ela caiu no meio). Roda junto com
     * os outros jobs.
     */
    @Scheduled(fixedDelayString = "${lotou.inventory.jobs.projection-recovery-interval:10s}")
    public void recoverAbandoned() {
        PendingMessages pending = this.streams.pending(RedisKeys.RESERVATION_STREAM, GROUP, Range.unbounded(), BATCH);
        RecordId[] abandoned = pending.stream()
                .filter(message -> message.getElapsedTimeSinceLastDelivery().compareTo(ABANDONED_AFTER) > 0)
                .map(PendingMessage::getId)
                .toArray(RecordId[]::new);
        if (abandoned.length == 0) {
            return;
        }
        List<MapRecord<String, Object, Object>> claimed = this.streams.claim(RedisKeys.RESERVATION_STREAM, GROUP,
                this.consumerName, ABANDONED_AFTER, abandoned);
        log.warn("Entradas abandonadas do stream de reservas assumidas: {}", claimed.size());
        applyAndAck(claimed);
    }

    /**
     * Apara o stream até a entrada mais antiga que ainda não chegou ao Postgres. É o equivalente ao
     * MAXLEN do documento, sem o risco de descartar o que ninguém gravou.
     */
    @Scheduled(fixedDelayString = "${lotou.inventory.jobs.stream-trim-interval:60s}")
    public void trim() {
        String keepFrom = oldestUnapplied();
        if (keepFrom != null) {
            this.redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) connection -> connection
                    .execute("XTRIM", bytes(RedisKeys.RESERVATION_STREAM), bytes("MINID"), bytes(keepFrom)));
        }
        forgetStoppedConsumers();
    }

    /**
     * Cada instância entra no grupo com um nome próprio, e uma instância que parou deixa o nome lá.
     * Sem nada pendente e parado há uma hora, o nome sai do grupo: o que ele tinha pendente já foi
     * assumido por outra instância.
     */
    private void forgetStoppedConsumers() {
        if (!Boolean.TRUE.equals(this.redis.hasKey(RedisKeys.RESERVATION_STREAM))) {
            return;
        }
        this.streams.consumers(RedisKeys.RESERVATION_STREAM, GROUP).stream()
                .filter(consumer -> consumer.pendingCount() == 0)
                .filter(consumer -> consumer.idleTime().compareTo(Duration.ofHours(1)) > 0)
                .filter(consumer -> !consumer.consumerName().equals(this.consumerName))
                .forEach(consumer -> this.streams.deleteConsumer(RedisKeys.RESERVATION_STREAM,
                        Consumer.from(GROUP, consumer.consumerName())));
    }

    /** Se tudo o que já entrou no stream foi gravado no Postgres (os testes esperam por isso). */
    public boolean caughtUp() {
        var info = this.streams.info(RedisKeys.RESERVATION_STREAM);
        var group = this.streams.groups(RedisKeys.RESERVATION_STREAM).stream()
                .filter(candidate -> candidate.groupName().equals(GROUP))
                .findFirst();
        return group.isPresent() && group.get().pendingCount() == 0
                && group.get().lastDeliveredId().equals(info.lastGeneratedId());
    }

    private String oldestUnapplied() {
        if (!Boolean.TRUE.equals(this.redis.hasKey(RedisKeys.RESERVATION_STREAM))) {
            return null;
        }
        var group = this.streams.groups(RedisKeys.RESERVATION_STREAM).stream()
                .filter(candidate -> candidate.groupName().equals(GROUP))
                .findFirst();
        if (group.isEmpty()) {
            return null;
        }
        var summary = this.streams.pending(RedisKeys.RESERVATION_STREAM, GROUP);
        if (summary.getTotalPendingMessages() > 0) {
            return summary.minRecordId().getValue();
        }
        // Nada pendente: tudo até a última entrada entregue já foi gravado. Ela mesma pode sair.
        RecordId last = RecordId.of(group.get().lastDeliveredId());
        return last.getTimestamp() + "-" + (last.getSequence() + 1);
    }

    private void applyAndAck(List<MapRecord<String, Object, Object>> records) {
        this.transaction.executeWithoutResult(status -> records.forEach(this::apply));
        this.streams.acknowledge(RedisKeys.RESERVATION_STREAM, GROUP,
                records.stream().map(MapRecord::getId).toArray(RecordId[]::new));
        this.applied.add(records.size());
    }

    private void apply(MapRecord<String, Object, Object> record) {
        Entry entry = this.json.readValue(String.valueOf(record.getValue().get("data")), Entry.class);
        long seq = sequence(record.getId());
        if (entry.reservation() != null) {
            upsertReservation(entry.reservation(), seq);
            if (entry.limit() != null) {
                upsertLimit(entry.reservation(), entry.limit(), seq);
            }
            if (entry.seatStatus() != null) {
                String seats = entry.seats() != null ? entry.seats() : entry.reservation().seats();
                updateSeats(seats, entry.seatStatus(), entry.reservation().id(), seq);
            }
        }
        if (entry.lots() != null) {
            entry.lots().forEach(lot -> this.jdbc.sql("""
                    UPDATE lots SET available = :available, status = :status, redis_seq = :seq
                    WHERE id = :id AND redis_seq < :seq
                    """)
                    .param("available", lot.available())
                    .param("status", lot.status())
                    .param("seq", seq)
                    .param("id", lot.id())
                    .update());
        }
    }

    private void upsertReservation(ReservationPayload r, long seq) {
        long priceCents = this.jdbc.sql("SELECT price_cents FROM lots WHERE id = :id").param("id", r.lot())
                .query(Long.class).single();
        try {
            this.jdbc.sql("""
                    INSERT INTO reservations (id, show_id, sector_id, buyer_id, cpf_hash, status, quantity,
                                              total_cents, expires_at, idempotency_key, request_hash,
                                              created_at, updated_at, redis_seq)
                    VALUES (:id, :show, :sector, :buyer, :cpf, :status, :qty, :total, :expiresAt, :idem,
                            :rhash, :createdAt, :updatedAt, :seq)
                    ON CONFLICT (id) DO UPDATE
                    SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at, redis_seq = EXCLUDED.redis_seq
                    WHERE reservations.redis_seq < EXCLUDED.redis_seq
                    """)
                    .param("id", r.id())
                    .param("show", r.show())
                    .param("sector", r.sector())
                    .param("buyer", r.buyer())
                    .param("cpf", r.cpf())
                    .param("status", r.status())
                    .param("qty", r.qty())
                    .param("total", Math.multiplyExact(priceCents, r.qty()))
                    .param("expiresAt", millis(r.expiresAt()))
                    .param("idem", r.idempotencyKey())
                    .param("rhash", r.requestHash())
                    .param("createdAt", millis(r.createdAt()))
                    .param("updatedAt", millis(r.updatedAt()))
                    .param("seq", seq)
                    .update();
        }
        catch (DataIntegrityViolationException ex) {
            // Só acontece se o Redis perdeu uma Idempotency-Key e a mesma chave gerou outra reserva.
            log.error("Reserva {} recusada pelo Postgres; segue para não travar o stream", r.id(), ex);
            return;
        }
        insertItems(r, priceCents);
    }

    /** Um item por ingresso, na ordem das cadeiras no mapa. Só grava os que ainda não existem. */
    private void insertItems(ReservationPayload r, long priceCents) {
        List<UUID> seatIds = r.seats() == null || r.seats().isBlank() ? List.of()
                : java.util.Arrays.stream(r.seats().split(",")).map(UUID::fromString).toList();
        for (int position = 0; position < r.qty(); position++) {
            UUID seatId = seatIds.isEmpty() ? null : seatIds.get(position);
            this.jdbc.sql("""
                    INSERT INTO reservation_items (id, reservation_id, position, lot_id, lot_name, seat_id,
                                                   seat_label, unit_price_cents)
                    SELECT :id, :reservation, :position, l.id, l.name, :seat,
                           (SELECT label FROM seats WHERE id = :seat), l.price_cents
                    FROM lots l WHERE l.id = :lot
                    ON CONFLICT (reservation_id, position) DO NOTHING
                    """)
                    .param("id", br.com.lotou.inventory.shared.UuidV7.generate())
                    .param("reservation", r.id())
                    .param("position", position)
                    .param("seat", seatId)
                    .param("lot", r.lot())
                    .update();
        }
    }

    private void upsertLimit(ReservationPayload r, int quantity, long seq) {
        this.jdbc.sql("""
                INSERT INTO purchase_limits AS pl (show_id, cpf_hash, quantity, redis_seq)
                VALUES (:show, :cpf, :quantity, :seq)
                ON CONFLICT (show_id, cpf_hash) DO UPDATE
                SET quantity = EXCLUDED.quantity, redis_seq = EXCLUDED.redis_seq
                WHERE pl.redis_seq < EXCLUDED.redis_seq
                """)
                .param("show", r.show())
                .param("cpf", r.cpf())
                .param("quantity", quantity)
                .param("seq", seq)
                .update();
    }

    private void updateSeats(String seats, String status, UUID reservationId, long seq) {
        if (seats == null || seats.isBlank()) {
            return;
        }
        for (String seat : seats.split(",")) {
            this.jdbc.sql("""
                    UPDATE seats SET status = :status, reservation_id = :reservation, redis_seq = :seq
                    WHERE id = :id AND redis_seq < :seq
                    """)
                    .param("status", status)
                    .param("reservation", status.equals("AVAILABLE") ? null : reservationId)
                    .param("seq", seq)
                    .param("id", UUID.fromString(seat))
                    .update();
        }
    }

    /** A posição da entrada no stream como um número que cresce: milissegundos e sequência. */
    static long sequence(RecordId id) {
        return Math.addExact(Math.multiplyExact(id.getTimestamp(), 1_000_000L), id.getSequence());
    }

    private void ensureGroup() {
        try {
            if (!Boolean.TRUE.equals(this.redis.hasKey(RedisKeys.RESERVATION_STREAM))) {
                // Cria o stream vazio junto com o grupo (XGROUP CREATE ... MKSTREAM).
                this.redis.execute((org.springframework.data.redis.core.RedisCallback<Object>) connection -> connection
                        .execute("XGROUP", bytes("CREATE"), bytes(RedisKeys.RESERVATION_STREAM), bytes(GROUP),
                                bytes("0"), bytes("MKSTREAM")));
            }
            else {
                this.streams.createGroup(RedisKeys.RESERVATION_STREAM, ReadOffset.from("0"), GROUP);
            }
        }
        catch (RedisSystemException ex) {
            if (!String.valueOf(ex.getMostSpecificCause().getMessage()).contains("BUSYGROUP")) {
                throw ex;
            }
        }
    }

    private void pause(String message, Exception ex) {
        log.error(message, ex);
        try {
            Thread.sleep(1_000);
        }
        catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static Timestamp millis(long epochMillis) {
        return Timestamp.from(Instant.ofEpochMilli(epochMillis));
    }

    private static byte[] bytes(String value) {
        return value.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }
}

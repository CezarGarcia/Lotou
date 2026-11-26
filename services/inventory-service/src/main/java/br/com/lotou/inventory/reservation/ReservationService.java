package br.com.lotou.inventory.reservation;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.inventory.catalog.Sector;
import br.com.lotou.inventory.catalog.SectorKind;
import br.com.lotou.inventory.catalog.SectorRepository;
import br.com.lotou.inventory.config.InventoryProperties;
import br.com.lotou.inventory.lot.Lot;
import br.com.lotou.inventory.lot.LotRepository;
import br.com.lotou.inventory.lot.SectorLots;
import br.com.lotou.inventory.seat.Seat;
import br.com.lotou.inventory.seat.SeatRepository;
import br.com.lotou.inventory.shared.Cpf;
import br.com.lotou.inventory.shared.CpfHasher;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.shared.problem.Problems;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Scope;
import jakarta.persistence.EntityManager;

import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Reserva de ingressos com lock no Postgres.
 *
 * <p>Uma reserva é uma transação só, que trava as linhas na mesma ordem em qualquer caminho, para
 * não haver deadlock: cota do CPF, lotes do setor e, na cadeira numerada, as cadeiras. Se qualquer
 * passo recusa, a transação inteira é desfeita e nada fica segurado pela metade.
 *
 * <p>É a linha de base do projeto: a fase 2 troca este caminho por um script Lua no Redis e mede
 * a diferença (ADR 3).
 */
@Service
public class ReservationService {

    /** O resultado de pedir uma reserva. */
    public record Outcome(Reservation reservation, String sectorName, boolean replayed) {
    }

    private final ReservationRepository reservations;
    private final SectorRepository sectors;
    private final LotRepository lots;
    private final SeatRepository seats;
    private final PurchaseLimits limits;
    private final CpfHasher cpfHasher;
    private final ReservationTelemetry telemetry;
    private final EntityManager entityManager;
    private final TransactionTemplate transaction;
    private final InventoryProperties.Reservation config;
    private final Clock clock;

    public ReservationService(ReservationRepository reservations, SectorRepository sectors, LotRepository lots,
            SeatRepository seats, PurchaseLimits limits, CpfHasher cpfHasher, ReservationTelemetry telemetry,
            EntityManager entityManager, PlatformTransactionManager transactionManager,
            InventoryProperties properties, Clock clock) {
        this.reservations = reservations;
        this.sectors = sectors;
        this.lots = lots;
        this.seats = seats;
        this.limits = limits;
        this.cpfHasher = cpfHasher;
        this.telemetry = telemetry;
        this.entityManager = entityManager;
        this.transaction = new TransactionTemplate(transactionManager);
        // Sob disputa extrema, é melhor recusar do que deixar a requisição presa na fila do lock.
        this.transaction.setTimeout(5);
        this.config = properties.reservation();
        this.clock = clock;
    }

    /**
     * Reserva ingressos para o comprador. Com a mesma {@code Idempotency-Key}, devolve a reserva já
     * criada em vez de reservar de novo (clique duplo, retry após timeout).
     */
    public Outcome reserve(String buyerId, String idempotencyKey, CreateReservationRequest request) {
        if (!Cpf.isValid(request.cpf())) {
            throw new ProblemException(HttpStatus.BAD_REQUEST, "validation-error", "Requisição inválida",
                    "Um ou mais campos da requisição são inválidos.")
                    .with("errors", List.of(new FieldError("cpf", "CPF inválido")));
        }
        Sector sector = this.sectors.findById(new Sector.Key(request.showId(), request.sectorId()))
                .orElseThrow(() -> Problems.notFound("Setor"));
        Selection selection = Selection.of(request, sector.getKind());
        String cpfHash = this.cpfHasher.hash(request.cpf());
        String requestHash = sha256(String.join("|", request.showId().toString(), request.sectorId().toString(),
                String.valueOf(selection.quantity()), String.join(",", selection.seats()), cpfHash));

        Optional<Reservation> existing = this.reservations.findByBuyerIdAndIdempotencyKey(buyerId, idempotencyKey);
        if (existing.isPresent()) {
            return replay(existing.get(), sector, requestHash);
        }

        Span span = GlobalOpenTelemetry.getTracer("lotou.inventory").spanBuilder("reserve tickets")
                .setAttribute("lotou.show.id", request.showId().toString())
                .setAttribute("lotou.sector.id", request.sectorId().toString())
                .setAttribute("lotou.reservation.quantity", selection.quantity())
                .startSpan();
        try (Scope ignored = span.makeCurrent()) {
            Reservation reservation = this.transaction.execute(status -> hold(buyerId, idempotencyKey, sector,
                    selection, cpfHash, requestHash));
            this.telemetry.reservation(sector.getKind(), "reserved");
            return new Outcome(reservation, sector.getName(), false);
        }
        catch (DataIntegrityViolationException ex) {
            // Duas requisições com a mesma chave chegaram juntas: o índice único deixou uma passar.
            return this.reservations.findByBuyerIdAndIdempotencyKey(buyerId, idempotencyKey)
                    .map(winner -> replay(winner, sector, requestHash))
                    .orElseThrow(() -> ex);
        }
        catch (ProblemException ex) {
            this.telemetry.reservation(sector.getKind(), ex.slug());
            span.setAttribute("lotou.reservation.result", ex.slug());
            throw ex;
        }
        catch (RuntimeException ex) {
            span.setStatus(StatusCode.ERROR);
            span.recordException(ex);
            throw ex;
        }
        finally {
            span.end();
        }
    }

    private Reservation hold(String buyerId, String idempotencyKey, Sector sector, Selection selection,
            String cpfHash, String requestHash) {
        UUID showId = sector.getShowId();
        UUID sectorId = sector.getId();
        int quantity = selection.quantity();

        // 1. Cota do CPF: máximo de ingressos por CPF em cada show.
        if (!this.limits.tryTake(showId, cpfHash, quantity, this.config.maxTicketsPerCpf())) {
            int remaining = Math.max(0, this.config.maxTicketsPerCpf() - this.limits.used(showId, cpfHash));
            throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "purchase-limit-exceeded",
                    "Limite de ingressos por CPF", "O limite é de %d ingressos por CPF em cada show. Restam %d."
                            .formatted(this.config.maxTicketsPerCpf(), remaining))
                    .with("remaining", remaining);
        }

        // 2. Estoque: trava os lotes do setor e tira do lote em venda.
        Lot lot = new SectorLots(this.lots.lockBySector(showId, sectorId)).reserve(quantity);

        // 3. Cadeiras: todas ou nenhuma.
        List<Seat> held = selection.seats().isEmpty() ? List.of() : holdSeats(showId, sectorId, selection.seats());

        // Milissegundos: a mesma precisão que o cliente recebe e que o banco devolve.
        Instant now = this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
        Reservation reservation = Reservation.hold(showId, sectorId, buyerId, cpfHash, lot, quantity, held, now,
                now.plus(this.config.ttl()), idempotencyKey, requestHash);
        this.entityManager.persist(reservation);
        held.forEach(seat -> seat.hold(reservation.getId()));
        return reservation;
    }

    private List<Seat> holdSeats(UUID showId, UUID sectorId, List<String> labels) {
        List<Seat> locked = this.seats.lockByLabels(showId, sectorId, labels);
        if (locked.size() != labels.size()) {
            List<String> found = locked.stream().map(Seat::getLabel).toList();
            throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "seat-not-found", "Cadeira inexistente",
                    "Uma ou mais cadeiras não existem neste setor.")
                    .with("seats", labels.stream().filter(label -> !found.contains(label)).toList());
        }
        List<String> taken = locked.stream().filter(seat -> !seat.isAvailable()).map(Seat::getLabel).sorted().toList();
        if (!taken.isEmpty()) {
            this.telemetry.seatConflict();
            throw new ProblemException(HttpStatus.CONFLICT, "seat-unavailable", "Cadeira ocupada",
                    "Uma ou mais cadeiras já foram escolhidas por outra pessoa.").with("seats", taken);
        }
        // Os itens da reserva seguem a ordem das cadeiras no mapa.
        return locked.stream().sorted(Comparator.comparingInt(Seat::getPosition)).toList();
    }

    private Outcome replay(Reservation reservation, Sector sector, String requestHash) {
        if (!reservation.getRequestHash().equals(requestHash)) {
            throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, "idempotency-key-reused",
                    "Idempotency-Key reutilizada",
                    "Esta Idempotency-Key já foi usada com outra reserva. Gere uma chave nova para cada operação.");
        }
        return new Outcome(reservation, sector.getName(), true);
    }

    /** A reserva do comprador. Reserva de outra pessoa é 404, não 403. */
    @Transactional(readOnly = true)
    public Outcome getOwned(UUID id, String buyerId) {
        Reservation reservation = this.reservations.findById(id)
                .filter(found -> found.getBuyerId().equals(buyerId))
                .orElseThrow(() -> Problems.notFound("Reserva"));
        return describe(reservation);
    }

    @Transactional(readOnly = true)
    public Outcome get(UUID id) {
        return describe(this.reservations.findById(id).orElseThrow(() -> Problems.notFound("Reserva")));
    }

    /**
     * HELD -> CONFIRMED: o pagamento foi aprovado e os ingressos estão vendidos. Confirmar de novo
     * uma reserva já confirmada não muda nada.
     */
    @Transactional
    public Outcome confirm(UUID id) {
        Reservation reservation = lock(id);
        if (reservation.is(ReservationStatus.CONFIRMED)) {
            return describe(reservation);
        }
        requireHeld(reservation);
        reservation.transitionTo(ReservationStatus.CONFIRMED, this.clock.instant());
        this.seats.lockByReservation(id).forEach(Seat::sell);
        return describe(reservation);
    }

    /** HELD -> RELEASED: o pagamento foi recusado e os ingressos voltam à venda. */
    @Transactional
    public Outcome release(UUID id) {
        Reservation reservation = lock(id);
        if (reservation.is(ReservationStatus.RELEASED)) {
            return describe(reservation);
        }
        requireHeld(reservation);
        giveBack(reservation, ReservationStatus.RELEASED);
        return describe(reservation);
    }

    /**
     * HELD -> EXPIRED, se o prazo acabou. Quem chama é o job de expiração; se a reserva foi
     * confirmada ou liberada enquanto ele esperava o lock, não faz nada.
     *
     * @return se a reserva expirou agora
     */
    @Transactional
    public boolean expire(UUID id) {
        Reservation reservation = lock(id);
        if (!reservation.is(ReservationStatus.HELD) || !reservation.expired(this.clock.instant())) {
            return false;
        }
        giveBack(reservation, ReservationStatus.EXPIRED);
        return true;
    }

    /** Devolve à venda o que a reserva segurava: cota do CPF, estoque do setor e cadeiras. */
    private void giveBack(Reservation reservation, ReservationStatus target) {
        reservation.transitionTo(target, this.clock.instant());
        this.limits.giveBack(reservation.getShowId(), reservation.getCpfHash(), reservation.getQuantity());
        new SectorLots(this.lots.lockBySector(reservation.getShowId(), reservation.getSectorId()))
                .giveBack(reservation.getQuantity());
        this.seats.lockByReservation(reservation.getId()).forEach(Seat::release);
    }

    private Reservation lock(UUID id) {
        return this.reservations.lockById(id).orElseThrow(() -> Problems.notFound("Reserva"));
    }

    private static void requireHeld(Reservation reservation) {
        if (!reservation.is(ReservationStatus.HELD)) {
            throw new ProblemException(HttpStatus.CONFLICT, "reservation-not-held", "Reserva não está mais ativa",
                    "A reserva está em %s e não pode mais ser alterada.".formatted(reservation.getStatus()))
                    .with("status", reservation.getStatus());
        }
    }

    private Outcome describe(Reservation reservation) {
        // Carrega os itens dentro da transação.
        reservation.getItems().size();
        String sectorName = this.sectors.findById(new Sector.Key(reservation.getShowId(), reservation.getSectorId()))
                .map(Sector::getName)
                .orElse("");
        return new Outcome(reservation, sectorName, false);
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        }
        catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 indisponível", ex);
        }
    }

    private record FieldError(String field, String message) {
    }

    /** O que o comprador pediu, já conferido contra o tipo do setor. */
    private record Selection(int quantity, List<String> seats) {

        static Selection of(CreateReservationRequest request, SectorKind kind) {
            boolean hasSeats = request.seats() != null && !request.seats().isEmpty();
            if (kind == SectorKind.GENERAL_ADMISSION) {
                if (hasSeats || request.quantity() == null) {
                    throw invalid("quantity", "Neste setor não há lugar marcado: informe só a quantidade");
                }
                return new Selection(request.quantity(), List.of());
            }
            if (!hasSeats) {
                throw invalid("seats", "Neste setor o lugar é marcado: escolha as cadeiras");
            }
            List<String> seats = request.seats().stream().distinct().sorted().toList();
            if (seats.size() != request.seats().size()) {
                throw invalid("seats", "A mesma cadeira aparece mais de uma vez");
            }
            if (request.quantity() != null && request.quantity() != seats.size()) {
                throw invalid("quantity", "A quantidade não bate com as cadeiras escolhidas");
            }
            return new Selection(seats.size(), seats);
        }

        private static ProblemException invalid(String field, String message) {
            return new ProblemException(HttpStatus.BAD_REQUEST, "validation-error", "Requisição inválida",
                    "Um ou mais campos da requisição são inválidos.")
                    .with("errors", List.of(new FieldError(field, message)));
        }
    }
}

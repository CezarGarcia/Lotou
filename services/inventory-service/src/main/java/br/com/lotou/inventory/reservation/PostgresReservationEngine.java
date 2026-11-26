package br.com.lotou.inventory.reservation;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.inventory.config.InventoryProperties;
import br.com.lotou.inventory.lot.Lot;
import br.com.lotou.inventory.lot.LotRepository;
import br.com.lotou.inventory.lot.SectorLots;
import br.com.lotou.inventory.seat.Seat;
import br.com.lotou.inventory.seat.SeatRepository;
import br.com.lotou.inventory.shared.problem.InventoryProblems;
import br.com.lotou.inventory.shared.problem.Problems;
import jakarta.persistence.EntityManager;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Reserva com lock no Postgres (fase 1).
 *
 * <p>Uma reserva é uma transação só, que trava as linhas na mesma ordem em qualquer caminho, para
 * não haver deadlock: cota do CPF, lotes do setor e, na cadeira numerada, as cadeiras. Se qualquer
 * passo recusa, a transação inteira é desfeita e nada fica segurado pela metade.
 *
 * <p>Travar os lotes do setor serializa as reservas do setor. É a linha de base que o motor Redis
 * precisa superar (ADR 3).
 */
@Component
@ConditionalOnProperty(name = "lotou.inventory.engine", havingValue = "postgres")
public class PostgresReservationEngine implements ReservationEngine {

    private final ReservationRepository reservations;
    private final LotRepository lots;
    private final SeatRepository seats;
    private final PurchaseLimits limits;
    private final EntityManager entityManager;
    private final TransactionTemplate transaction;
    private final InventoryProperties.Reservation config;
    private final Clock clock;

    public PostgresReservationEngine(ReservationRepository reservations, LotRepository lots, SeatRepository seats,
            PurchaseLimits limits, EntityManager entityManager, PlatformTransactionManager transactionManager,
            InventoryProperties properties, Clock clock) {
        this.reservations = reservations;
        this.lots = lots;
        this.seats = seats;
        this.limits = limits;
        this.entityManager = entityManager;
        this.transaction = new TransactionTemplate(transactionManager);
        // Sob disputa extrema, é melhor recusar do que deixar a requisição presa na fila do lock.
        this.transaction.setTimeout(5);
        this.config = properties.reservation();
        this.clock = clock;
    }

    @Override
    public Held hold(HoldCommand command) {
        Optional<Reservation> existing = this.reservations.findByBuyerIdAndIdempotencyKey(command.buyerId(),
                command.idempotencyKey());
        if (existing.isPresent()) {
            return replay(existing.get(), command);
        }
        try {
            return new Held(this.transaction.execute(status -> holdLocked(command)), false);
        }
        catch (DataIntegrityViolationException ex) {
            // Duas requisições com a mesma chave chegaram juntas: o índice único deixou uma passar.
            return this.reservations.findByBuyerIdAndIdempotencyKey(command.buyerId(), command.idempotencyKey())
                    .map(winner -> replay(winner, command))
                    .orElseThrow(() -> ex);
        }
    }

    private ReservationView holdLocked(HoldCommand command) {
        UUID showId = command.sector().showId();
        UUID sectorId = command.sector().id();
        int quantity = command.quantity();

        // 1. Cota do CPF: máximo de ingressos por CPF em cada show.
        if (!this.limits.tryTake(showId, command.cpfHash(), quantity, this.config.maxTicketsPerCpf())) {
            int remaining = Math.max(0,
                    this.config.maxTicketsPerCpf() - this.limits.used(showId, command.cpfHash()));
            throw InventoryProblems.purchaseLimitExceeded(this.config.maxTicketsPerCpf(), remaining);
        }

        // 2. Estoque: trava os lotes do setor e tira do lote em venda.
        Lot lot = new SectorLots(this.lots.lockBySector(showId, sectorId)).reserve(quantity);

        // 3. Cadeiras: todas ou nenhuma.
        List<Seat> held = command.seats().isEmpty() ? List.of() : holdSeats(showId, sectorId, command.seats());

        // Milissegundos: a mesma precisão que o cliente recebe e que o banco devolve.
        Instant now = this.clock.instant().truncatedTo(ChronoUnit.MILLIS);
        Reservation reservation = Reservation.hold(showId, sectorId, command.buyerId(), command.cpfHash(), lot,
                quantity, held, now, now.plus(this.config.ttl()), command.idempotencyKey(), command.requestHash());
        this.entityManager.persist(reservation);
        held.forEach(seat -> seat.hold(reservation.getId()));
        return ReservationView.of(reservation);
    }

    private List<Seat> holdSeats(UUID showId, UUID sectorId, List<String> labels) {
        List<Seat> locked = this.seats.lockByLabels(showId, sectorId, labels);
        if (locked.size() != labels.size()) {
            List<String> found = locked.stream().map(Seat::getLabel).toList();
            throw InventoryProblems.seatNotFound(labels.stream().filter(label -> !found.contains(label)).toList());
        }
        List<String> taken = locked.stream().filter(seat -> !seat.isAvailable()).map(Seat::getLabel).sorted().toList();
        if (!taken.isEmpty()) {
            throw InventoryProblems.seatUnavailable(taken);
        }
        // Os itens da reserva seguem a ordem das cadeiras no mapa.
        return locked.stream().sorted(Comparator.comparingInt(Seat::getPosition)).toList();
    }

    private static Held replay(Reservation reservation, HoldCommand command) {
        if (!reservation.getRequestHash().equals(command.requestHash())) {
            throw InventoryProblems.idempotencyKeyReused();
        }
        return new Held(ReservationView.of(reservation), true);
    }

    @Override
    public Optional<ReservationView> find(UUID id) {
        return this.transaction.execute(status -> this.reservations.findById(id).map(ReservationView::of));
    }

    @Override
    public ReservationView confirm(UUID id) {
        return this.transaction.execute(status -> {
            Reservation reservation = lock(id);
            if (!reservation.is(ReservationStatus.CONFIRMED)) {
                requireHeld(reservation);
                reservation.transitionTo(ReservationStatus.CONFIRMED, this.clock.instant());
                this.seats.lockByReservation(id).forEach(Seat::sell);
            }
            return ReservationView.of(reservation);
        });
    }

    @Override
    public ReservationView release(UUID id) {
        return this.transaction.execute(status -> {
            Reservation reservation = lock(id);
            if (!reservation.is(ReservationStatus.RELEASED)) {
                requireHeld(reservation);
                giveBack(reservation, ReservationStatus.RELEASED);
            }
            return ReservationView.of(reservation);
        });
    }

    @Override
    public boolean expire(UUID id) {
        return Boolean.TRUE.equals(this.transaction.execute(status -> {
            Reservation reservation = lock(id);
            if (!reservation.is(ReservationStatus.HELD) || !reservation.expired(this.clock.instant())) {
                return false;
            }
            giveBack(reservation, ReservationStatus.EXPIRED);
            return true;
        }));
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
        Reservation reservation = this.reservations.lockById(id).orElseThrow(() -> Problems.notFound("Reserva"));
        // Carrega os itens dentro da transação.
        reservation.getItems().size();
        return reservation;
    }

    private static void requireHeld(Reservation reservation) {
        if (!reservation.is(ReservationStatus.HELD)) {
            throw InventoryProblems.reservationNotHeld(reservation.getStatus());
        }
    }
}

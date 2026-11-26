package br.com.lotou.inventory.reservation;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

import br.com.lotou.inventory.catalog.Sector;
import br.com.lotou.inventory.catalog.SectorKind;
import br.com.lotou.inventory.catalog.SectorRepository;
import br.com.lotou.inventory.shared.Cpf;
import br.com.lotou.inventory.shared.CpfHasher;
import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.shared.problem.Problems;
import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.StatusCode;
import io.opentelemetry.context.Scope;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * Porta de entrada das reservas: valida o pedido, transforma o CPF em hash e entrega ao motor de
 * reserva configurado ({@link ReservationEngine}). O que vem antes e depois do motor (validação,
 * span, métricas e contrato de resposta) é igual nos dois motores.
 */
@Service
public class ReservationService {

    /** O resultado de pedir ou consultar uma reserva. */
    public record Outcome(ReservationView reservation, String sectorName, boolean replayed) {
    }

    private final ReservationEngine engine;
    private final SectorRepository sectors;
    private final CpfHasher cpfHasher;
    private final ReservationTelemetry telemetry;

    public ReservationService(ReservationEngine engine, SectorRepository sectors, CpfHasher cpfHasher,
            ReservationTelemetry telemetry) {
        this.engine = engine;
        this.sectors = sectors;
        this.cpfHasher = cpfHasher;
        this.telemetry = telemetry;
    }

    /**
     * Reserva ingressos para o comprador. Com a mesma {@code Idempotency-Key}, devolve a reserva já
     * criada em vez de reservar de novo (clique duplo, retry após timeout).
     */
    public Outcome reserve(String buyerId, String idempotencyKey, CreateReservationRequest request) {
        if (!Cpf.isValid(request.cpf())) {
            throw invalid("cpf", "CPF inválido");
        }
        Sector sector = this.sectors.findById(new Sector.Key(request.showId(), request.sectorId()))
                .orElseThrow(() -> Problems.notFound("Setor"));
        Selection selection = Selection.of(request, sector.getKind());
        String cpfHash = this.cpfHasher.hash(request.cpf());
        String requestHash = sha256(String.join("|", request.showId().toString(), request.sectorId().toString(),
                String.valueOf(selection.quantity()), String.join(",", selection.seats()), cpfHash));

        Span span = GlobalOpenTelemetry.getTracer("lotou.inventory").spanBuilder("reserve tickets")
                .setAttribute("lotou.show.id", request.showId().toString())
                .setAttribute("lotou.sector.id", request.sectorId().toString())
                .setAttribute("lotou.reservation.quantity", selection.quantity())
                .startSpan();
        try (Scope ignored = span.makeCurrent()) {
            ReservationEngine.Held held = this.engine.hold(new ReservationEngine.HoldCommand(buyerId,
                    idempotencyKey, sector, selection.quantity(), selection.seats(), cpfHash, requestHash));
            if (!held.replayed()) {
                this.telemetry.reservation(sector.getKind(), "reserved");
            }
            return new Outcome(held.reservation(), sector.getName(), held.replayed());
        }
        catch (ProblemException ex) {
            this.telemetry.reservation(sector.getKind(), ex.slug());
            if (ex.slug().equals("seat-unavailable")) {
                this.telemetry.seatConflict();
            }
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

    /** A reserva do comprador. Reserva de outra pessoa é 404, não 403. */
    public Outcome getOwned(UUID id, String buyerId) {
        return describe(this.engine.find(id)
                .filter(found -> found.buyerId().equals(buyerId))
                .orElseThrow(() -> Problems.notFound("Reserva")));
    }

    public Outcome get(UUID id) {
        return describe(this.engine.find(id).orElseThrow(() -> Problems.notFound("Reserva")));
    }

    public Outcome confirm(UUID id) {
        return describe(this.engine.confirm(id));
    }

    public Outcome release(UUID id) {
        return describe(this.engine.release(id));
    }

    public boolean expire(UUID id) {
        return this.engine.expire(id);
    }

    private Outcome describe(ReservationView reservation) {
        String sectorName = this.sectors.findById(new Sector.Key(reservation.showId(), reservation.sectorId()))
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

    private static ProblemException invalid(String field, String message) {
        return new ProblemException(HttpStatus.BAD_REQUEST, "validation-error", "Requisição inválida",
                "Um ou mais campos da requisição são inválidos.")
                .with("errors", List.of(new FieldError(field, message)));
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
    }
}

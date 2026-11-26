package br.com.lotou.inventory.lot;

import java.time.Instant;
import java.util.UUID;

import br.com.lotou.inventory.shared.problem.Problems;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Lote de um setor: um preço e um contador de ingressos que ainda podem ser reservados.
 *
 * <p>O contador só muda com a linha travada ({@code SELECT ... FOR UPDATE}), dentro de {@link
 * SectorLots}.
 */
@Entity
@Table(name = "lots")
public class Lot {

    private static final Logger log = LoggerFactory.getLogger(Lot.class);

    @Id
    private UUID id;

    private UUID showId;

    private UUID sectorId;

    private String name;

    /** Preço em centavos, inteiro. */
    private long priceCents;

    private int quantity;

    private int available;

    private int position;

    private Instant opensAt;

    @Enumerated(EnumType.STRING)
    private LotStatus status;

    protected Lot() {
    }

    /** Para testes das regras de lote, sem banco. */
    public Lot(UUID id, String name, long priceCents, int quantity, int position, Instant opensAt) {
        this.id = id;
        this.name = name;
        this.priceCents = priceCents;
        this.quantity = quantity;
        this.available = quantity;
        this.position = position;
        this.opensAt = opensAt;
        this.status = LotStatus.SCHEDULED;
    }

    /** Recusa, e registra em log, a transição que não está na tabela. */
    void transitionTo(LotStatus target) {
        if (!this.status.canTransitionTo(target)) {
            log.warn("Transição de estado recusada: lote {} de {} para {}", this.id, this.status, target);
            throw Problems.invalidTransition("Um lote", this.status, target);
        }
        this.status = target;
    }

    void take(int amount) {
        if (amount > this.available) {
            throw new IllegalStateException("Lote %s sem estoque: pedidos %d, restam %d"
                    .formatted(this.id, amount, this.available));
        }
        this.available -= amount;
    }

    void add(int amount) {
        this.available += amount;
    }

    public UUID getId() {
        return this.id;
    }

    public UUID getShowId() {
        return this.showId;
    }

    public UUID getSectorId() {
        return this.sectorId;
    }

    public String getName() {
        return this.name;
    }

    public long getPriceCents() {
        return this.priceCents;
    }

    public int getQuantity() {
        return this.quantity;
    }

    public int getAvailable() {
        return this.available;
    }

    public int getPosition() {
        return this.position;
    }

    public Instant getOpensAt() {
        return this.opensAt;
    }

    public LotStatus getStatus() {
        return this.status;
    }

    public boolean is(LotStatus status) {
        return this.status == status;
    }
}

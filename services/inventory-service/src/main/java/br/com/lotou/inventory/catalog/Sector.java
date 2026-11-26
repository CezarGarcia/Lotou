package br.com.lotou.inventory.catalog;

import java.io.Serializable;
import java.util.UUID;

import jakarta.persistence.Embeddable;
import jakarta.persistence.EmbeddedId;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Table;

/** Setor de um show. A capacidade pertence ao setor; o lote só define preço e quantidade. */
@Entity
@Table(name = "sectors")
public class Sector {

    /** O ID do setor vem do local, e o mesmo local recebe vários shows: a chave é o par. */
    @Embeddable
    public record Key(UUID showId, UUID id) implements Serializable {
    }

    @EmbeddedId
    private Key key;

    private String name;

    @Enumerated(EnumType.STRING)
    private SectorKind kind;

    private int capacity;

    private int position;

    protected Sector() {
    }

    public UUID getId() {
        return this.key.id();
    }

    public UUID getShowId() {
        return this.key.showId();
    }

    public String getName() {
        return this.name;
    }

    public SectorKind getKind() {
        return this.kind;
    }

    public int getCapacity() {
        return this.capacity;
    }

    public int getPosition() {
        return this.position;
    }
}

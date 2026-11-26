package br.com.lotou.inventory.lot;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.List;

import br.com.lotou.inventory.shared.UuidV7;
import br.com.lotou.inventory.shared.problem.ProblemException;
import org.junit.jupiter.api.Test;

/** Regras de lote de um setor, sem banco. */
class SectorLotsTests {

    private static final Instant NOW = Instant.parse("2027-01-10T13:00:00Z");

    private final Lot first = lot("1º lote", 10_000, 3, 0, null);
    private final Lot second = lot("2º lote", 14_000, 2, 1, null);
    private final SectorLots sector = new SectorLots(List.of(second, first));

    private static Lot lot(String name, long priceCents, int quantity, int position, Instant opensAt) {
        return new Lot(UuidV7.generate(), name, priceCents, quantity, position, opensAt);
    }

    private static String slugOf(Throwable error) {
        return ((ProblemException) error).slug();
    }

    @Test
    void antesDaAberturaNaoVende() {
        assertThat(this.sector.sale()).isEqualTo(SectorLots.Sale.NOT_OPEN);
        assertThatThrownBy(() -> this.sector.reserve(1)).satisfies(e -> assertThat(slugOf(e)).isEqualTo("sales-not-open"));
    }

    @Test
    void aberturaColocaSoOPrimeiroLoteEmVenda() {
        this.sector.openSales();
        this.sector.openSales(); // abrir de novo não muda nada

        assertThat(this.first.getStatus()).isEqualTo(LotStatus.ON_SALE);
        assertThat(this.second.getStatus()).isEqualTo(LotStatus.SCHEDULED);
    }

    @Test
    void reservaSaiDoLoteEmVendaAoPrecoDele() {
        this.sector.openSales();

        Lot lot = this.sector.reserve(2);

        assertThat(lot).isSameAs(this.first);
        assertThat(lot.getPriceCents()).isEqualTo(10_000);
        assertThat(this.first.getAvailable()).isEqualTo(1);
    }

    @Test
    void quandoOContadorZeraOLoteEsgotaEOProximoAbre() {
        this.sector.openSales();

        this.sector.reserve(3);

        assertThat(this.first.getStatus()).isEqualTo(LotStatus.SOLD_OUT);
        assertThat(this.second.getStatus()).isEqualTo(LotStatus.ON_SALE);
        assertThat(this.sector.reserve(1)).isSameAs(this.second);
    }

    @Test
    void reservaNaoAtravessaLotes() {
        this.sector.openSales();
        this.sector.reserve(2);

        assertThatThrownBy(() -> this.sector.reserve(2)).satisfies(e -> {
            assertThat(slugOf(e)).isEqualTo("insufficient-stock");
            assertThat(((ProblemException) e).toProblemDetail().getProperties()).containsEntry("available", 1);
        });
        assertThat(this.first.getAvailable()).isEqualTo(1);
    }

    @Test
    void ultimoLoteEsgotadoDeixaOSetorEsgotado() {
        this.sector.openSales();
        this.sector.reserve(3);
        this.sector.reserve(2);

        assertThat(this.sector.sale()).isEqualTo(SectorLots.Sale.SOLD_OUT);
        assertThatThrownBy(() -> this.sector.reserve(1)).satisfies(e -> assertThat(slugOf(e)).isEqualTo("sold-out"));
    }

    @Test
    void ingressoDevolvidoVoltaParaOLoteEmVendaNuncaParaOMaisBarato() {
        this.sector.openSales();
        this.sector.reserve(3); // esgota o 1º lote; o 2º abre

        this.sector.giveBack(2);

        assertThat(this.first.getStatus()).isEqualTo(LotStatus.SOLD_OUT);
        assertThat(this.first.getAvailable()).isZero();
        assertThat(this.second.getAvailable()).isEqualTo(4);
    }

    @Test
    void ingressoDevolvidoComOSetorEsgotadoReabreOUltimoLote() {
        this.sector.openSales();
        this.sector.reserve(3);
        this.sector.reserve(2);

        this.sector.giveBack(1);

        assertThat(this.first.getStatus()).isEqualTo(LotStatus.SOLD_OUT);
        assertThat(this.second.getStatus()).isEqualTo(LotStatus.ON_SALE);
        assertThat(this.second.getAvailable()).isEqualTo(1);
        assertThat(this.sector.reserve(1).getPriceCents()).isEqualTo(14_000);
    }

    @Test
    void lotePausadoNaoAceitaReservaMasRecebeDevolucao() {
        this.sector.openSales();
        this.sector.reserve(1);
        this.sector.pause(this.first.getId());

        assertThatThrownBy(() -> this.sector.reserve(1)).satisfies(e -> assertThat(slugOf(e)).isEqualTo("sales-paused"));
        this.sector.giveBack(1);
        assertThat(this.first.getAvailable()).isEqualTo(3);

        this.sector.resume(this.first.getId());
        assertThat(this.sector.reserve(1)).isSameAs(this.first);
    }

    @Test
    void soPausaLoteEmVendaESoRetomaLotePausado() {
        this.sector.openSales();

        assertThatThrownBy(() -> this.sector.pause(this.second.getId()))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("invalid-state-transition"));
        assertThatThrownBy(() -> this.sector.resume(this.first.getId()))
                .satisfies(e -> assertThat(slugOf(e)).isEqualTo("invalid-state-transition"));
    }

    @Test
    void viradaPorDataPassaOQueSobrouParaOProximoLote() {
        Lot early = lot("1º lote", 10_000, 5, 0, null);
        Lot dated = lot("2º lote", 14_000, 5, 1, NOW);
        var dated2 = new SectorLots(List.of(early, dated));
        dated2.openSales();
        dated2.reserve(2);

        assertThat(dated2.turnByDate(NOW.minusSeconds(1))).isFalse();
        assertThat(dated2.turnByDate(NOW)).isTrue();

        assertThat(early.getStatus()).isEqualTo(LotStatus.SOLD_OUT);
        assertThat(early.getAvailable()).isZero();
        assertThat(dated.getStatus()).isEqualTo(LotStatus.ON_SALE);
        // 5 do lote novo mais os 3 que sobraram do anterior, agora ao preço novo.
        assertThat(dated.getAvailable()).isEqualTo(8);
        assertThat(dated2.turnByDate(NOW)).isFalse();
    }

    @Test
    void lotePausadoNaoViraPorData() {
        Lot early = lot("1º lote", 10_000, 5, 0, null);
        Lot dated = lot("2º lote", 14_000, 5, 1, NOW);
        var lots = new SectorLots(List.of(early, dated));
        lots.openSales();
        lots.pause(early.getId());

        assertThat(lots.turnByDate(NOW)).isFalse();
        assertThat(dated.getStatus()).isEqualTo(LotStatus.SCHEDULED);
    }

    @Test
    void encerramentoFechaOLoteEmVendaENadaMaisVoltaAVenda() {
        this.sector.openSales();
        this.sector.reserve(1);

        this.sector.closeSales();
        this.sector.giveBack(1);

        assertThat(this.first.getStatus()).isEqualTo(LotStatus.CLOSED);
        assertThat(this.first.getAvailable()).isEqualTo(2);
        assertThat(this.sector.sale()).isEqualTo(SectorLots.Sale.CLOSED);
        assertThatThrownBy(() -> this.sector.reserve(1)).satisfies(e -> assertThat(slugOf(e)).isEqualTo("sales-closed"));
    }
}

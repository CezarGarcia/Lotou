package br.com.lotou.inventory.lot;

import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import br.com.lotou.inventory.shared.problem.ProblemException;
import br.com.lotou.inventory.shared.problem.Problems;

import org.springframework.http.HttpStatus;

/**
 * Os lotes de um setor, em ordem de virada, e as regras que valem para o conjunto (seção "Lotes"
 * de docs/projeto.md):
 *
 * <ul>
 *   <li>só um lote do setor fica em venda por vez;
 *   <li>o próximo lote abre quando o atual esgota ou na data definida pelo produtor, o que vier
 *       primeiro;
 *   <li>ingressos devolvidos voltam para o lote em venda, ao preço dele, e nunca reabrem um lote
 *       mais barato.
 * </ul>
 *
 * <p>Não acessa o banco: quem usa carrega os lotes do setor já travados e o Hibernate grava o que
 * mudou no fim da transação. Travar o setor inteiro serializa as reservas do setor, e é esse o
 * gargalo que a fase 2 mede contra o Redis (ADR 3).
 */
public final class SectorLots {

    /** O que a loja mostra para o setor. */
    public enum Sale {
        NOT_OPEN,
        ON_SALE,
        PAUSED,
        SOLD_OUT,
        CLOSED
    }

    private final List<Lot> lots;

    public SectorLots(List<Lot> lots) {
        this.lots = lots.stream().sorted(Comparator.comparingInt(Lot::getPosition)).toList();
    }

    /** O lote em venda ou pausado, se houver. */
    public Optional<Lot> current() {
        return this.lots.stream()
                .filter(lot -> lot.is(LotStatus.ON_SALE) || lot.is(LotStatus.PAUSED))
                .findFirst();
    }

    public Sale sale() {
        if (this.lots.stream().anyMatch(lot -> lot.is(LotStatus.CLOSED))) {
            return Sale.CLOSED;
        }
        Optional<Lot> current = current();
        if (current.isPresent()) {
            return current.get().is(LotStatus.PAUSED) ? Sale.PAUSED : Sale.ON_SALE;
        }
        boolean opened = this.lots.stream().anyMatch(lot -> !lot.is(LotStatus.SCHEDULED));
        return opened ? Sale.SOLD_OUT : Sale.NOT_OPEN;
    }

    /**
     * Tira {@code quantity} ingressos do lote em venda e devolve o lote, que define o preço. A
     * reserva sai de um lote só: se ele não tem a quantidade pedida, a reserva é recusada e o
     * erro informa quantos restam. Quando o contador zera, o lote esgota e o próximo abre.
     */
    public Lot reserve(int quantity) {
        Lot lot = switch (sale()) {
            case ON_SALE -> current().orElseThrow();
            case NOT_OPEN -> throw new ProblemException(HttpStatus.CONFLICT, "sales-not-open",
                    "Vendas ainda não abriram", "As vendas deste setor ainda não abriram.");
            case PAUSED -> throw new ProblemException(HttpStatus.CONFLICT, "sales-paused", "Vendas pausadas",
                    "As vendas deste setor estão pausadas no momento.");
            case CLOSED -> throw new ProblemException(HttpStatus.CONFLICT, "sales-closed", "Vendas encerradas",
                    "As vendas deste show foram encerradas.");
            case SOLD_OUT -> throw new ProblemException(HttpStatus.CONFLICT, "sold-out", "Ingressos esgotados",
                    "Os ingressos deste setor esgotaram.");
        };
        if (lot.getAvailable() < quantity) {
            throw new ProblemException(HttpStatus.CONFLICT, "insufficient-stock", "Ingressos insuficientes",
                    "Restam %d ingressos neste lote.".formatted(lot.getAvailable()))
                    .with("available", lot.getAvailable());
        }
        lot.take(quantity);
        if (lot.getAvailable() == 0) {
            lot.transitionTo(LotStatus.SOLD_OUT);
            nextScheduled().ifPresent(next -> next.transitionTo(LotStatus.ON_SALE));
        }
        return lot;
    }

    /**
     * Devolve ingressos à venda (reserva expirada, pagamento recusado ou reembolso). Eles voltam
     * para o lote em venda, ao preço dele. Se o setor não tem lote em venda, o último lote esgotado
     * reabre. Depois que as vendas encerram, não há mais para onde devolver.
     */
    public void giveBack(int quantity) {
        if (sale() == Sale.CLOSED) {
            return;
        }
        Optional<Lot> current = current();
        if (current.isPresent()) {
            current.get().add(quantity);
            return;
        }
        this.lots.stream()
                .filter(lot -> lot.is(LotStatus.SOLD_OUT))
                .max(Comparator.comparingInt(Lot::getPosition))
                .ifPresent(last -> {
                    last.transitionTo(LotStatus.ON_SALE);
                    last.add(quantity);
                });
    }

    /** Abertura das vendas: o primeiro lote do setor entra em venda. */
    public void openSales() {
        if (sale() == Sale.NOT_OPEN) {
            this.lots.stream().findFirst().ifPresent(first -> first.transitionTo(LotStatus.ON_SALE));
        }
    }

    /**
     * Virada por data: se chegou a data do próximo lote, o lote em venda esgota e o que sobrou dele
     * passa para o próximo, ao preço novo. Um lote pausado não vira sozinho.
     *
     * @return se algum lote virou
     */
    public boolean turnByDate(Instant now) {
        boolean turned = false;
        while (true) {
            Optional<Lot> current = current().filter(lot -> lot.is(LotStatus.ON_SALE));
            Optional<Lot> next = nextScheduled()
                    .filter(lot -> lot.getOpensAt() != null && !lot.getOpensAt().isAfter(now));
            if (current.isEmpty() || next.isEmpty()) {
                return turned;
            }
            int leftover = current.get().getAvailable();
            current.get().take(leftover);
            current.get().transitionTo(LotStatus.SOLD_OUT);
            next.get().transitionTo(LotStatus.ON_SALE);
            next.get().add(leftover);
            turned = true;
        }
    }

    /** Encerramento das vendas do show: o lote em venda ou pausado fecha. */
    public void closeSales() {
        current().ifPresent(lot -> lot.transitionTo(LotStatus.CLOSED));
    }

    public void pause(UUID lotId) {
        find(lotId).transitionTo(LotStatus.PAUSED);
    }

    public void resume(UUID lotId) {
        Lot lot = find(lotId);
        if (!lot.is(LotStatus.PAUSED)) {
            throw Problems.invalidTransition("Um lote", lot.getStatus(), LotStatus.ON_SALE);
        }
        lot.transitionTo(LotStatus.ON_SALE);
    }

    private Lot find(UUID lotId) {
        return this.lots.stream()
                .filter(lot -> lot.getId().equals(lotId))
                .findFirst()
                .orElseThrow(() -> Problems.notFound("Lote"));
    }

    private Optional<Lot> nextScheduled() {
        return this.lots.stream().filter(lot -> lot.is(LotStatus.SCHEDULED)).findFirst();
    }
}

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MoneyPipe } from '../../core/format/money.pipe';
import { SectorAvailability } from '../data/sale.models';
import { Sector } from '../data/show.models';
import { SaleChip } from '../shared/sale-chip';
import { KIND_LABELS } from './buy-panel';

/**
 * Um setor na página do show: o lote em venda e o preço dele, quanto do lote
 * já saiu (quando a conta fecha com os dados) e o lote seguinte. Sem lote em
 * venda, a lista de preços dos lotes.
 */
@Component({
  selector: 'app-sector-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MoneyPipe, SaleChip],
  host: { class: 'panel' },
  template: `
    @let s = sector();
    @let l = live();
    <header>
      <div>
        <h3>{{ s.name }}</h3>
        <p class="meta">{{ kindLabels[s.kind] }} · {{ capacityLabel() }}</p>
      </div>
      @if (l) {
        <app-sale-chip [sale]="l.sale" />
      }
    </header>

    @if (l?.lot; as lot) {
      <div class="current">
        <p class="line">
          <span>
            {{ lot.name }} · <strong class="num">{{ lot.priceCents | brl }}</strong>
          </span>
          @if (soldPercent() !== null) {
            <span class="muted">{{ soldPercent() }}% do lote vendido</span>
          }
        </p>
        @if (soldPercent() !== null) {
          <div class="bar" aria-hidden="true">
            <div [style.width.%]="soldPercent()"></div>
          </div>
        }
        @if (l!.sale === 'ON_SALE') {
          <p class="note">
            {{ availableLabel() }}
            @if (nextLot(); as next) {
              Depois dele vem o {{ next.name }}, a {{ next.priceCents | brl }}.
            }
          </p>
        } @else if (l!.sale === 'PAUSED') {
          <p class="note">As vendas deste lote estão pausadas pelo produtor.</p>
        }
      </div>
    } @else if (s.lots.length > 0) {
      <ol class="lots">
        @for (lot of s.lots; track lot.id) {
          <li>
            <span>{{ lot.name }}</span>
            <strong class="num">{{ lot.priceCents | brl }}</strong>
          </li>
        }
      </ol>
    } @else {
      <p class="note">Preços em breve.</p>
    }
  `,
  styleUrl: './sector-card.scss',
})
export class SectorCard {
  readonly sector = input.required<Sector>();
  readonly live = input<SectorAvailability>();

  protected readonly kindLabels = KIND_LABELS;

  private readonly lotIndex = computed(() => {
    const id = this.live()?.lot?.id;
    return id ? this.sector().lots.findIndex((lot) => lot.id === id) : -1;
  });

  protected readonly nextLot = computed(() => this.sector().lots[this.lotIndex() + 1] ?? null);

  /**
   * Quanto do lote em venda já saiu, pelo tamanho do lote e o que resta nele.
   * Quando sobra de um lote anterior passa para o atual, o que resta pode ser
   * maior que o lote: aí a porcentagem não diria nada e some.
   */
  protected readonly soldPercent = computed(() => {
    const live = this.live();
    const lot = this.sector().lots[this.lotIndex()];
    if (!live || !lot || lot.quantity <= 0 || live.available > lot.quantity) {
      return null;
    }
    return Math.round(((lot.quantity - live.available) / lot.quantity) * 100);
  });

  protected readonly capacityLabel = computed(() => {
    const { capacity, kind } = this.sector();
    const count = capacity.toLocaleString('pt-BR');
    return kind === 'RESERVED_SEATING' ? `${count} lugares` : `${count} ingressos`;
  });

  protected readonly availableLabel = computed(() => {
    const count = this.live()?.available ?? 0;
    return count === 1
      ? 'Resta 1 ingresso neste lote.'
      : `Restam ${count.toLocaleString('pt-BR')} ingressos neste lote.`;
  });
}

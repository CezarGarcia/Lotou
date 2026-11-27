import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { CountPipe } from '../../core/format/count.pipe';
import { MoneyPipe } from '../../core/format/money.pipe';
import { cartazPalette } from '../../shared/ui/cartaz-palette';
import { LOT_STATUS_LABELS, label } from '../shared/labels';
import { SectorMetrics } from './live.protocol';

/**
 * Um setor no painel: vendidos sobre a capacidade (barra em CSS puro, sem
 * biblioteca de gráficos), restantes e o lote em venda com preço e situação.
 * Cada setor tem a sua cor, tirada das tintas dos cartazes pelo nome.
 */
@Component({
  selector: 'app-sector-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CountPipe, MoneyPipe],
  host: { '[style.--setor]': 'color()' },
  template: `
    @let s = sector();
    <div class="head">
      <h3>{{ s.name }}</h3>
      <span class="sold num"
        >{{ s.sold | count }} de {{ s.capacity | count }} vendidos · {{ percent() }}%</span
      >
    </div>
    <div
      class="bar"
      role="meter"
      [attr.aria-label]="'Vendidos em ' + s.name"
      aria-valuemin="0"
      [attr.aria-valuemax]="s.capacity"
      [attr.aria-valuenow]="s.sold"
      [attr.aria-valuetext]="
        (s.sold | count) + ' de ' + (s.capacity | count) + ' vendidos (' + percent() + '%)'
      "
    >
      <span [style.width.%]="ratio() * 100"></span>
    </div>
    <div class="foot">
      <p class="lot">
        <span class="swatch" aria-hidden="true"></span>
        @if (s.currentLot; as lot) {
          {{ lot.name }} · {{ lot.priceCents | brl }}
          <span class="lot-status" [attr.data-status]="lot.status">{{ lotStatus() }}</span>
        } @else {
          As vendas ainda não abriram
        }
      </p>
      <p class="remaining num">
        <strong>{{ s.remaining | count }}</strong>
        {{ s.remaining === 1 ? 'restante' : 'restantes' }}
      </p>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      gap: 10px;
    }
    h3,
    p {
      margin: 0;
    }
    h3 {
      font-size: 1rem;
      font-weight: 700;
    }
    .head,
    .foot {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 4px 12px;
    }
    .sold,
    .remaining {
      color: var(--lt-muted);
      font-size: 0.9375rem;
    }
    strong {
      color: var(--lt-text);
    }
    .bar {
      height: 14px;
      overflow: hidden;
      border-radius: 99px;
      background: var(--lt-bg-deep);
    }
    .bar span {
      display: block;
      height: 100%;
      background: var(--setor);
      box-shadow: inset 0 0 0 1px rgb(18 16 21 / 0.12);
      transition: width 0.4s ease;
    }
    .foot {
      font-size: 0.8125rem;
    }
    .lot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      color: var(--lt-muted);
    }
    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 3px;
      background: var(--setor);
    }
    .lot-status {
      padding: 1px 8px;
      border-radius: 999px;
      background: var(--lt-bg-deep);
      color: var(--lt-text-3);
      font-family: var(--lt-mono);
      font-size: 0.6875rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .lot-status[data-status='ON_SALE'] {
      background: var(--lt-ok-soft);
      color: #145c42;
    }
    .lot-status[data-status='SOLD_OUT'] {
      background: var(--lt-danger-soft);
      color: var(--lt-danger);
    }
    .lot-status[data-status='PAUSED'] {
      background: var(--lt-warn-soft);
      color: var(--lt-warn);
    }
  `,
})
export class SectorCard {
  readonly sector = input.required<SectorMetrics>();

  /** Fração vendida, de 0 a 1. */
  protected readonly ratio = computed(() => {
    const { sold, capacity } = this.sector();
    return capacity > 0 ? Math.min(1, sold / capacity) : 0;
  });

  /** Porcentagem arredondada para baixo: 99,9% não aparece como 100% antes de esgotar. */
  protected readonly percent = computed(() => Math.floor(this.ratio() * 100));

  protected readonly lotStatus = computed(() =>
    label(LOT_STATUS_LABELS, this.sector().currentLot?.status ?? ''),
  );

  /** A cor do setor, a mesma em toda visita ao painel. */
  protected readonly color = computed(() => cartazPalette(this.sector().name).background);
}

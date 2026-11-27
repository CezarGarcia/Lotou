import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { CountPipe } from '../../core/format/count.pipe';
import { MoneyPipe } from '../../core/format/money.pipe';
import { LOT_STATUS_LABELS, label } from '../shared/labels';
import { SectorMetrics } from './live.protocol';

/**
 * Um setor no painel: vendidos sobre a capacidade (barra em CSS puro, sem
 * biblioteca de gráficos), restantes e o lote em venda com preço e situação.
 */
@Component({
  selector: 'app-sector-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CountPipe, MatIconModule, MoneyPipe],
  template: `
    @let s = sector();
    <div class="head">
      <h3>{{ s.name }}</h3>
      @if (s.currentLot; as lot) {
        <span class="chip" [attr.data-status]="lot.status">{{ lotStatus() }}</span>
      }
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
    <p class="numbers">
      <span>
        <strong>{{ s.sold | count }}</strong> de {{ s.capacity | count }} vendidos ·
        {{ percent() }}%
      </span>
      <span>
        <strong>{{ s.remaining | count }}</strong>
        {{ s.remaining === 1 ? 'restante' : 'restantes' }}
      </span>
    </p>
    <p class="lot">
      @if (s.currentLot; as lot) {
        <mat-icon aria-hidden="true">sell</mat-icon>
        {{ lot.name }} · {{ lot.priceCents | brl }}
      } @else {
        <mat-icon aria-hidden="true">schedule</mat-icon>
        As vendas ainda não abriram
      }
    </p>
  `,
  styles: `
    :host {
      display: grid;
      gap: 8px;
      padding: 16px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 16px;
    }
    h3,
    p {
      margin: 0;
    }
    h3 {
      font: var(--mat-sys-title-medium);
      font-weight: 700;
    }
    .head,
    .numbers {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 4px 12px;
    }
    .numbers {
      font-variant-numeric: tabular-nums;
      color: var(--mat-sys-on-surface-variant);
    }
    strong {
      color: var(--mat-sys-on-surface);
    }
    .bar {
      height: 12px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--mat-sys-surface-container-highest);
    }
    .bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--mat-sys-primary);
      transition: width 400ms ease;
    }
    .chip {
      padding: 2px 10px;
      border-radius: 999px;
      background: var(--mat-sys-surface-container-highest);
      font: var(--mat-sys-label-medium);
      font-weight: 600;
    }
    .chip[data-status='ON_SALE'] {
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    .chip[data-status='SOLD_OUT'] {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
    .lot {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .lot mat-icon {
      width: 18px;
      height: 18px;
      font-size: 18px;
      color: var(--mat-sys-on-surface-variant);
    }
    @media (prefers-reduced-motion: reduce) {
      .bar span {
        transition: none;
      }
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
}

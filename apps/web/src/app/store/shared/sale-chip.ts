import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SaleState } from '../data/sale.models';
import { SALE_LABELS } from './live-availability';

/** Situação das vendas de um setor: à venda, esgotado, pausado... */
@Component({
  selector: 'app-sale-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ labels[sale()] }}`,
  host: { '[attr.data-sale]': 'sale()' },
  styles: `
    :host {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font: var(--mat-sys-label-medium);
      font-weight: 600;
      white-space: nowrap;
      background: var(--mat-sys-surface-container-highest);
      color: var(--mat-sys-on-surface-variant);
    }
    :host([data-sale='ON_SALE']) {
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    :host([data-sale='NOT_OPEN']) {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }
    :host([data-sale='PAUSED']) {
      background: var(--mat-sys-tertiary-container);
      color: var(--mat-sys-on-tertiary-container);
    }
    :host([data-sale='SOLD_OUT']) {
      background: var(--mat-sys-error-container);
      color: var(--mat-sys-on-error-container);
    }
  `,
})
export class SaleChip {
  readonly sale = input.required<SaleState>();
  protected readonly labels = SALE_LABELS;
}

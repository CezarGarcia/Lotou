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
      --tag: var(--lt-muted);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px;
      border: 1px solid var(--tag);
      border-radius: 999px;
      color: var(--tag);
      font-family: var(--lt-mono);
      font-size: 0.75rem;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    :host([data-sale='ON_SALE']) {
      --tag: var(--lt-ok);
    }
    :host([data-sale='NOT_OPEN']) {
      --tag: var(--lt-info);
    }
    :host([data-sale='PAUSED']) {
      --tag: var(--lt-warn);
    }
    :host([data-sale='SOLD_OUT']) {
      --tag: var(--lt-danger);
    }
  `,
})
export class SaleChip {
  readonly sale = input.required<SaleState>();
  protected readonly labels = SALE_LABELS;
}

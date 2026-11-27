import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArmchair, lucideTicket } from '@ng-icons/lucide';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ReservationItem } from '../data/sale.models';

/**
 * O que está reservado: o setor e cada ingresso (a cadeira, quando é lugar
 * marcado), com o lote e o preço congelado. O título leva o `id` que a seção
 * da página usa como nome.
 */
@Component({
  selector: 'app-reservation-items',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, MoneyPipe],
  viewProviders: [provideIcons({ lucideArmchair, lucideTicket })],
  host: { class: 'panel' },
  template: `
    <h2 [id]="titleId()">{{ sectorName() }}</h2>
    <ul>
      @for (item of items(); track $index) {
        <li>
          <span class="what">
            <ng-icon [name]="item.seat ? 'lucideArmchair' : 'lucideTicket'" aria-hidden="true" />
            <span>
              {{ item.seat ? 'Cadeira ' + item.seat : 'Ingresso' }}
              <small>{{ item.lotName }}</small>
            </span>
          </span>
          <strong>{{ item.unitPriceCents | brl }}</strong>
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
      padding: 22px 24px;
    }
    h2 {
      margin: 0 0 8px;
      font-family: var(--lt-display);
      font-size: 2.25rem;
      font-weight: 900;
      line-height: 1;
      text-transform: uppercase;
    }
    ul {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 0;
      border-top: 1px dashed var(--lt-line-strong);
    }
    .what {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .what > ng-icon {
      font-size: 1.25rem;
      color: var(--lt-accent);
    }
    .what > span {
      display: grid;
      font-weight: 600;
    }
    small {
      color: var(--lt-muted);
      font-weight: 400;
    }
    strong {
      font-variant-numeric: tabular-nums;
    }
  `,
})
export class ReservationItems {
  readonly sectorName = input.required<string>();
  readonly items = input.required<readonly ReservationItem[]>();
  readonly titleId = input('items-title');
}

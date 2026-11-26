import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { TicketStatus } from '../data/sale.models';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { ShowHeading } from '../shared/show-heading';
import { CANCEL_REASONS, ORDER_STATUS_LABELS, OrderStore } from './order.store';

const TICKET_STATUS: Record<TicketStatus, string> = {
  VALID: 'Válido',
  USED: 'Utilizado',
  CANCELLED: 'Cancelado',
};

/**
 * Um pedido: os ingressos quando confirmado, o motivo quando cancelado e,
 * enquanto o pagamento é processado, a espera com consulta a cada 2 s.
 */
@Component({
  selector: 'app-order-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MoneyPipe,
    ShowDatePipe,
    ShowHeading,
  ],
  providers: [OrderStore],
  templateUrl: './order.page.html',
  styleUrl: './order.page.scss',
})
export class OrderPage {
  protected readonly store = inject(OrderStore);

  /** Parâmetro `:id` da rota. */
  readonly id = input.required<string>();

  protected readonly show = httpResource<Show>(() => {
    const showId = this.store.order()?.showId;
    return showId ? `${SHOWS_URL}/${showId}` : undefined;
  });

  protected readonly statusLabels = ORDER_STATUS_LABELS;
  protected readonly cancelReasons = CANCEL_REASONS;
  protected readonly ticketStatus = TICKET_STATUS;

  constructor() {
    effect(() => this.store.load(this.id()));
  }
}

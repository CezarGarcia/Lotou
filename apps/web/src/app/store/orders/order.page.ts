import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe, formatInTimezone } from '../../core/format/show-date.pipe';
import { Order, TicketStatus } from '../data/sale.models';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { ShowHeading } from '../shared/show-heading';
import { CancelOrderData, CancelOrderDialog } from './cancel-order.dialog';
import { TicketQr } from './ticket-qr';
import {
  CANCEL_REASONS,
  ORDER_STATUS_LABELS,
  OrderStore,
  cancellationBlockMessage,
} from './order.store';

const TICKET_STATUS: Record<TicketStatus, string> = {
  VALID: 'Válido',
  USED: 'Utilizado',
  CANCELLED: 'Cancelado',
};

/**
 * Um pedido: os ingressos quando confirmado (com o QR, a entrada registrada ou
 * o cancelamento de cada um), o cancelamento dentro da política, o reembolso
 * enquanto anda e, enquanto o pagamento é processado, a espera.
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
    TicketQr,
  ],
  providers: [OrderStore],
  templateUrl: './order.page.html',
  styleUrl: './order.page.scss',
})
export class OrderPage {
  protected readonly store = inject(OrderStore);
  private readonly dialog = inject(MatDialog);

  /** Parâmetro `:id` da rota. */
  readonly id = input.required<string>();

  protected readonly show = httpResource<Show>(() => {
    const showId = this.store.order()?.showId;
    return showId ? `${SHOWS_URL}/${showId}` : undefined;
  });

  protected readonly statusLabels = ORDER_STATUS_LABELS;
  protected readonly cancelReasons = CANCEL_REASONS;
  protected readonly ticketStatus = TICKET_STATUS;
  protected readonly blockMessage = cancellationBlockMessage;

  protected readonly hasValidTicket = computed(
    () => this.store.order()?.tickets.some((ticket) => ticket.status === 'VALID') ?? false,
  );

  constructor() {
    effect(() => this.store.load(this.id()));
  }

  /** "16/12/2026 às 20:31", no fuso do show. */
  protected at(instant: string, timezone: string | undefined): string {
    return `${formatInTimezone(instant, timezone, 'date')} às ${formatInTimezone(instant, timezone, 'time')}`;
  }

  /** Abre a confirmação com a política; só cancela se o comprador confirmar. */
  protected confirmCancel(order: Order, timezone: string | undefined): void {
    const data: CancelOrderData = {
      totalCents: order.totalCents,
      tickets: order.tickets.length || order.items.length,
      deadline: order.cancellation?.deadline ?? null,
      timezone,
    };
    this.dialog
      .open<CancelOrderDialog, CancelOrderData, boolean>(CancelOrderDialog, {
        data,
        maxWidth: '520px',
        autoFocus: 'first-tabbable',
        ariaModal: true,
      })
      .afterClosed()
      .subscribe((confirmed) => {
        if (confirmed) {
          this.store.cancel();
        }
      });
  }
}

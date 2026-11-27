import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleX,
  lucideCloudOff,
  lucideHeadset,
  lucideInfo,
  lucideLoaderCircle,
  lucideRotateCcw,
  lucideSearchX,
  lucideSun,
} from '@ng-icons/lucide';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe, formatInTimezone } from '../../core/format/show-date.pipe';
import { Order } from '../data/sale.models';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { ShowHeading } from '../shared/show-heading';
import { CancelOrderData, CancelOrderDialog } from './cancel-order.dialog';
import { TicketStub } from './ticket-stub';
import {
  CANCEL_REASONS,
  ORDER_STATUS_LABELS,
  OrderStore,
  cancellationBlockMessage,
} from './order.store';
import { BackLink } from '../checkout/back-link';

const DAY_MS = 86_400_000;

/**
 * Um pedido: os ingressos quando confirmado (com o QR, a entrada registrada ou
 * o cancelamento de cada um), o cancelamento dentro da política, o reembolso
 * enquanto anda e, enquanto o pagamento é processado, a espera.
 */
@Component({
  selector: 'app-order-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, BackLink, NgIcon, MoneyPipe, ShowDatePipe, ShowHeading, TicketStub],
  providers: [OrderStore],
  viewProviders: [
    provideIcons({
      lucideCircleCheck,
      lucideCircleX,
      lucideCloudOff,
      lucideHeadset,
      lucideInfo,
      lucideLoaderCircle,
      lucideRotateCcw,
      lucideSearchX,
      lucideSun,
    }),
  ],
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
  protected readonly blockMessage = cancellationBlockMessage;

  protected readonly hasValidTicket = computed(
    () => this.store.order()?.tickets.some((ticket) => ticket.status === 'VALID') ?? false,
  );

  /** Quanto falta para o show, contado em dias do calendário do local. */
  protected readonly countdown = computed(() => {
    if (!this.show.hasValue()) {
      return 'Seus ingressos estão logo abaixo.';
    }
    const { startsAt, venue } = this.show.value();
    const day = (instant: string | Date) =>
      Date.parse(formatInTimezone(instant, venue?.timezone, 'date').split('/').reverse().join('-'));
    const days = Math.round((day(startsAt) - day(new Date())) / DAY_MS);
    if (days < 0) {
      return 'Seus ingressos estão logo abaixo.';
    }
    if (days === 0) {
      return 'O show é hoje!';
    }
    return days === 1 ? 'O show é amanhã!' : `Faltam ${days} dias para o show.`;
  });

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

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowRight,
  lucideCloudOff,
  lucideLoaderCircle,
  lucideSmartphone,
  lucideTicket,
} from '@ng-icons/lucide';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { OrderStatus, OrderSummary } from '../data/sale.models';
import { TicketWallet } from '../wallet/ticket-wallet';
import { MyOrdersStore } from './my-orders.store';
import { ORDER_STATUS_LABELS } from './order.store';

/** Pedidos que não dão mais entrada: vão para "Passados e cancelados". */
const CLOSED = new Set<OrderStatus>(['CANCELLED', 'REFUNDING', 'REFUNDED', 'REFUND_FAILED']);

/** Depois do início, o show ainda conta como "próximo" por algumas horas (a noite do show). */
const SHOW_NIGHT_MS = 6 * 3_600_000;

/**
 * "Meus ingressos": os pedidos do comprador, separados entre os próximos
 * shows (com o cartaz) e os passados ou cancelados. Cada um leva ao detalhe,
 * onde está o QR.
 */
@Component({
  selector: 'app-my-tickets-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, MoneyPipe, ShowDatePipe, Cartaz],
  providers: [MyOrdersStore],
  viewProviders: [
    provideIcons({
      lucideArrowRight,
      lucideCloudOff,
      lucideLoaderCircle,
      lucideSmartphone,
      lucideTicket,
    }),
  ],
  templateUrl: './my-tickets.page.html',
  styleUrl: './my-tickets.page.scss',
})
export class MyTicketsPage {
  protected readonly store = inject(MyOrdersStore);
  protected readonly wallet = inject(TicketWallet);
  protected readonly statusLabels = ORDER_STATUS_LABELS;
  protected readonly skeletons = Array.from({ length: 3 });
  private readonly openedAt = Date.now();

  /** Próximos (do show mais perto ao mais longe) e passados ou cancelados. */
  protected readonly groups = computed(() => {
    const shows = this.store.shows();
    const startsAt = (order: OrderSummary) => {
      const show = shows.get(order.showId);
      return show ? Date.parse(show.startsAt) : Number.MAX_SAFE_INTEGER;
    };
    const upcoming: OrderSummary[] = [];
    const past: OrderSummary[] = [];
    for (const order of this.store.orders()) {
      const over = CLOSED.has(order.status) || startsAt(order) + SHOW_NIGHT_MS < this.openedAt;
      (over ? past : upcoming).push(order);
    }
    upcoming.sort((a, b) => startsAt(a) - startsAt(b));
    return { upcoming, past };
  });
}

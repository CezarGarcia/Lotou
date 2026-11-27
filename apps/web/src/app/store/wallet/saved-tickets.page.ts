import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCloudOff, lucideRefreshCw, lucideSmartphone, lucideSun } from '@ng-icons/lucide';
import { AuthService } from '../../core/auth/auth.service';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { NetworkStatus } from '../../core/ui/network-status';
import { Ticket } from '../data/sale.models';
import { Show } from '../data/show.models';
import { TicketStub } from '../orders/ticket-stub';
import { TicketWallet } from './ticket-wallet';

/**
 * Ingressos salvos neste aparelho (ADR 37). Pública de propósito: abre sem
 * internet e sem login, a partir do que a carteira guardou. Com internet e
 * login, atualiza a carteira ao abrir.
 */
@Component({
  selector: 'app-saved-tickets-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, NgIcon, ShowDatePipe, TicketStub],
  viewProviders: [provideIcons({ lucideCloudOff, lucideRefreshCw, lucideSmartphone, lucideSun })],
  templateUrl: './saved-tickets.page.html',
  styleUrl: './saved-tickets.page.scss',
})
export class SavedTicketsPage {
  protected readonly wallet = inject(TicketWallet);
  protected readonly network = inject(NetworkStatus);
  protected readonly auth = inject(AuthService);

  /** Um bloco por show, com os ingressos de todos os pedidos dele juntos. */
  protected readonly shows = computed(() => {
    const byShow = new Map<string, { show: Show; tickets: Ticket[] }>();
    for (const order of this.wallet.orders()) {
      const entry = byShow.get(order.show.id) ?? { show: order.show, tickets: [] };
      entry.tickets.push(
        ...order.tickets.filter((ticket) => ticket.status === 'VALID' && !!ticket.code),
      );
      byShow.set(order.show.id, entry);
    }
    return [...byShow.values()];
  });

  constructor() {
    // Com internet e login, a lista fica em dia (um cancelamento some daqui).
    effect(() => {
      const userId = this.auth.userId();
      if (this.network.online() && userId) {
        untracked(() => this.wallet.sync(userId).subscribe());
      }
    });
  }
}

import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBan, lucideUserCheck } from '@ng-icons/lucide';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { cartazPalette } from '../../shared/ui/cartaz-palette';
import { Ticket, TicketStatus } from '../data/sale.models';
import { Show } from '../data/show.models';
import { TicketQr } from './ticket-qr';

const TICKET_STATUS: Record<TicketStatus, string> = {
  VALID: 'Válido',
  USED: 'Utilizado',
  CANCELLED: 'Cancelado',
};

/**
 * Um ingresso como canhoto de papel: o cartaz do show no topo, a linha
 * picotada e, embaixo, data, portões, setor e lugar, com o QR grande sobre
 * fundo branco. Usado ou cancelado, o QR dá lugar a um carimbo.
 */
@Component({
  selector: 'app-ticket-stub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, Cartaz, ShowDatePipe, TicketQr],
  viewProviders: [provideIcons({ lucideBan, lucideUserCheck })],
  host: {
    '[class.inactive]': "ticket().status !== 'VALID'",
    '[style.--glow]': 'glow()',
  },
  templateUrl: './ticket-stub.html',
  styleUrl: './ticket-stub.scss',
})
export class TicketStub {
  readonly ticket = input.required<Ticket>();
  readonly show = input<Show>();

  protected readonly statusLabels = TICKET_STATUS;
  protected readonly tz = computed(() => this.show()?.venue?.timezone);
  protected readonly place = computed(() => {
    const seat = this.ticket().seat;
    return seat ? `Cadeira ${seat}` : 'Sem lugar marcado';
  });
  /** A sombra do ingresso tem a cor do cartaz do show. */
  protected readonly glow = computed(() => {
    const show = this.show();
    return show ? cartazPalette(show.artist).background : 'transparent';
  });
}

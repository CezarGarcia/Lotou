import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCalendarX,
  lucideChevronRight,
  lucideCloudOff,
  lucideMapPin,
  lucideRefreshCw,
} from '@ng-icons/lucide';
import { CountPipe } from '../../core/format/count.pipe';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { ShowStatus } from '../shared/show-status';
import { ProducerShowsStore } from './producer-shows.store';

/** Início do painel: os shows do produtor, cada um levando ao painel ao vivo. */
@Component({
  selector: 'app-producer-shows-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    Cartaz,
    CountPipe,
    RouterLink,
    MatButtonModule,
    MatProgressBarModule,
    MoneyPipe,
    NgIcon,
    ShowDatePipe,
    ShowStatus,
  ],
  viewProviders: [
    provideIcons({
      lucideCalendarX,
      lucideChevronRight,
      lucideCloudOff,
      lucideMapPin,
      lucideRefreshCw,
    }),
  ],
  providers: [ProducerShowsStore],
  templateUrl: './producer-shows.page.html',
  styleUrl: './producer-shows.page.scss',
})
export class ProducerShowsPage {
  protected readonly store = inject(ProducerShowsStore);
  protected readonly skeletons = Array.from({ length: 3 });
}

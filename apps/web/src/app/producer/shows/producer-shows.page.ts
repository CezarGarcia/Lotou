import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { CountPipe } from '../../core/format/count.pipe';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { SHOW_STATUS_LABELS, label } from '../shared/labels';
import { ProducerShowsStore } from './producer-shows.store';

/** Início do painel: os shows do produtor, cada um levando ao painel ao vivo. */
@Component({
  selector: 'app-producer-shows-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CountPipe,
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MoneyPipe,
    ShowDatePipe,
  ],
  providers: [ProducerShowsStore],
  templateUrl: './producer-shows.page.html',
  styleUrl: './producer-shows.page.scss',
})
export class ProducerShowsPage {
  protected readonly store = inject(ProducerShowsStore);
  protected readonly status = (value: string) => label(SHOW_STATUS_LABELS, value);
  protected readonly skeletons = Array.from({ length: 3 });
}

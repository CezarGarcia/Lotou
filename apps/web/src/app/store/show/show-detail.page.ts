import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { toApiError } from '../../core/http/problem';
import { SectorKind, Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { ShowCover } from '../shared/show-cover';
import { SalesCountdown } from './sales-countdown';

const KIND_LABELS: Record<SectorKind, string> = {
  GENERAL_ADMISSION: 'Sem lugar marcado',
  RESERVED_SEATING: 'Lugar marcado',
};

/** Página do show: data, local, setores, lotes e preços. */
@Component({
  selector: 'app-show-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatIconModule,
    MoneyPipe,
    ShowDatePipe,
    ShowCover,
    SalesCountdown,
  ],
  templateUrl: './show-detail.page.html',
  styleUrl: './show-detail.page.scss',
})
export class ShowDetailPage {
  private readonly title = inject(Title);

  /** Parâmetro `:id` da rota, ligado pelo roteador. */
  readonly id = input.required<string>();

  // Recarrega sozinho quando o id muda.
  protected readonly show = httpResource<Show>(() => `${SHOWS_URL}/${this.id()}`);

  protected readonly notFound = computed(() => {
    const error = this.show.error();
    return error instanceof HttpErrorResponse && [400, 404].includes(error.status);
  });
  protected readonly error = computed(() => {
    const error = this.show.error();
    return error ? toApiError(error) : undefined;
  });

  /** As vendas ainda vão abrir (e o show não foi cancelado). */
  protected readonly salesPending = computed(() => {
    if (!this.show.hasValue()) {
      return false;
    }
    const { salesStartAt, status } = this.show.value();
    return (
      status !== 'CANCELLED' &&
      salesStartAt !== null &&
      new Date(salesStartAt).getTime() > Date.now()
    );
  });

  protected readonly kindLabels = KIND_LABELS;

  constructor() {
    effect(() => {
      if (this.show.hasValue()) {
        const { artist, title } = this.show.value();
        this.title.setTitle(`${artist}: ${title} | Lotou.`);
      }
    });
  }
}

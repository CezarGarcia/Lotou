import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { toApiError } from '../../core/http/problem';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { injectLiveAvailability } from '../shared/live-availability';
import { SaleChip } from '../shared/sale-chip';
import { ShowCover } from '../shared/show-cover';
import { BuyPanel, KIND_LABELS } from './buy-panel';

/**
 * Página do show: data, local, setores e preços. O lote em venda, o preço e
 * quantos ingressos restam vêm da disponibilidade, consultada a cada 5 s.
 */
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
    SaleChip,
    BuyPanel,
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
  protected readonly availability = injectLiveAvailability(() => this.id());

  protected readonly notFound = computed(() => {
    const error = this.show.error();
    return error instanceof HttpErrorResponse && [400, 404].includes(error.status);
  });
  protected readonly error = computed(() => {
    const error = this.show.error();
    return error ? toApiError(error) : undefined;
  });

  /** Cada setor do show com a situação de venda dele agora. */
  protected readonly sectors = computed(() =>
    this.show.hasValue()
      ? this.show.value().sectors.map((sector) => ({
          sector,
          live: this.availability.sector(sector.id),
        }))
      : [],
  );

  protected readonly kindLabels = KIND_LABELS;

  constructor() {
    effect(() => {
      if (this.show.hasValue()) {
        const { artist, title } = this.show.value();
        this.title.setTitle(`${artist}: ${title} | Lotou.`);
      }
    });
  }

  protected availableLabel(count: number): string {
    return count === 1 ? '1 disponível' : `${count} disponíveis`;
  }
}

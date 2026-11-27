import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCloudOff, lucideSearchX } from '@ng-icons/lucide';
import { toApiError } from '../../core/http/problem';
import { cartazPalette } from '../../shared/ui/cartaz-palette';
import { Show } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { injectLiveAvailability } from '../shared/live-availability';
import { BuyPanel, KIND_LABELS } from './buy-panel';
import { SectorCard } from './sector-card';
import { ShowRules } from './show-rules';
import { ShowTop } from './show-top';

/**
 * Página do show: o cartaz, a data, o local, os setores e as regras, com o
 * painel de compra ao lado. O lote em venda, o preço e quantos ingressos
 * restam vêm da disponibilidade, consultada a cada 5 s.
 */
@Component({
  selector: 'app-show-detail-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, BuyPanel, SectorCard, ShowRules, ShowTop],
  viewProviders: [provideIcons({ lucideCloudOff, lucideSearchX })],
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

  /** Os tipos de setor do show (pista, cadeira numerada), sem repetir. */
  protected readonly kinds = computed(() =>
    this.show.hasValue() ? [...new Set(this.show.value().sectors.map((s) => s.kind))] : [],
  );

  /** A cor do cartaz, para as barras de venda e o palco do local. */
  protected readonly color = computed(() =>
    this.show.hasValue() ? cartazPalette(this.show.value().artist).background : null,
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
}

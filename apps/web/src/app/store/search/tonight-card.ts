import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight } from '@ng-icons/lucide';
import { MoneyPipe } from '../../core/format/money.pipe';
import { formatInTimezone } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { Show, ShowSummary } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';
import { injectNow } from '../shared/countdown';

/**
 * Um show de hoje, em faixa: o cartaz deitado, a hora e o local. O horário
 * dos portões vem do documento do show (a busca não traz): com ele, a faixa
 * acende o ponto verde enquanto os portões estão abertos.
 */
@Component({
  selector: 'app-tonight-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, Cartaz, MoneyPipe],
  viewProviders: [provideIcons({ lucideArrowRight })],
  template: `
    @let s = show();
    <a class="faixa panel" [routerLink]="['/shows', s.id]">
      <app-cartaz size="faixa" [artist]="s.artist" />
      <div class="text">
        <p class="eyebrow when" [class.live]="doorsOpen()">
          @if (doorsOpen()) {
            <span class="live-dot" aria-hidden="true"></span>
          }
          {{ when() }}
        </p>
        <h3 class="artist">{{ s.artist }}</h3>
        <p class="title">{{ s.title }}</p>
        <p class="meta">
          @if (s.venue; as venue) {
            {{ venue.name }}, {{ venue.city }}
          }
          @if (s.priceFromCents !== null) {
            · a partir de {{ s.priceFromCents | brl }}
          }
        </p>
      </div>
      <span class="btn btn-light go" aria-hidden="true">
        Ver ingressos
        <ng-icon name="lucideArrowRight" />
      </span>
    </a>
  `,
  styleUrl: './tonight-card.scss',
})
export class TonightCard {
  readonly show = input.required<ShowSummary>();

  private readonly now = injectNow(30_000);
  private readonly detail = httpResource<Show>(() => `${SHOWS_URL}/${this.show().id}`);

  private readonly doorsOpenAt = computed(() =>
    this.detail.hasValue() ? this.detail.value().doorsOpenAt : null,
  );

  private readonly started = computed(() => this.now() >= new Date(this.show().startsAt).getTime());

  /** Os portões já abriram e o show ainda não começou. */
  protected readonly doorsOpen = computed(() => {
    const doors = this.doorsOpenAt();
    return !!doors && this.now() >= new Date(doors).getTime() && !this.started();
  });

  protected readonly when = computed(() => {
    const { startsAt, venue } = this.show();
    const time = (instant: string) => formatInTimezone(instant, venue?.timezone, 'time');
    if (this.started()) {
      return `Hoje · começou às ${time(startsAt)}`;
    }
    if (this.doorsOpen()) {
      return `Portões abertos · show às ${time(startsAt)}`;
    }
    const doors = this.doorsOpenAt();
    return doors
      ? `Hoje · show às ${time(startsAt)} · portões às ${time(doors)}`
      : `Hoje · show às ${time(startsAt)}`;
  });
}

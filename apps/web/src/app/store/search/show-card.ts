import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { ShowSummary } from '../data/show.models';
import { showBadge } from './vitrine';

/**
 * Cartão de um show na vitrine: o cartaz em retrato e, embaixo, o que o
 * comprador lê. O cartão inteiro é um link para a página do show; o cartaz é
 * decorativo, então artista, data e local também aparecem em texto.
 */
@Component({
  selector: 'app-show-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Cartaz, MoneyPipe, ShowDatePipe],
  template: `
    @let s = show();
    @let tz = s.venue?.timezone;
    <a class="card" [routerLink]="['/shows', s.id]">
      <app-cartaz
        size="card"
        [artist]="s.artist"
        [eyebrow]="eyebrow()"
        [date]="s.startsAt"
        [timezone]="tz"
      />
      <div class="body">
        @if (badge(); as badge) {
          <span class="tag badge" [attr.data-tone]="badge.tone">{{ badge.label }}</span>
        }
        <h3 class="artist">{{ s.artist }}</h3>
        <p class="title">{{ s.title }}</p>
        <p class="meta when">
          {{ s.startsAt | showDate: tz : 'weekday' }}, {{ s.startsAt | showDate: tz : 'date' }} às
          {{ s.startsAt | showDate: tz : 'time' }}
        </p>
        @if (s.venue; as venue) {
          <p class="meta">{{ venue.name }} · {{ venue.city }}/{{ venue.state }}</p>
        }
        @if (s.priceFromCents !== null) {
          <p class="price">
            a partir de <strong class="num">{{ s.priceFromCents | brl }}</strong>
          </p>
        }
      </div>
    </a>
  `,
  styleUrl: './show-card.scss',
})
export class ShowCard {
  readonly show = input.required<ShowSummary>();

  protected readonly eyebrow = computed(() => {
    const venue = this.show().venue;
    return venue ? `${venue.city} · ${venue.state}` : '';
  });

  protected readonly badge = computed(() => showBadge(this.show(), new Date()));
}

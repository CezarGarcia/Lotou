import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { ShowSummary } from '../data/show.models';
import { ShowCover } from '../shared/show-cover';

/** Card de um show na busca. O card inteiro é um link para a página do show. */
@Component({
  selector: 'app-show-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ShowCover, MoneyPipe, ShowDatePipe],
  template: `
    @let s = show();
    <a class="card" [routerLink]="['/shows', s.id]" [attr.aria-label]="s.artist + ': ' + s.title">
      <div class="cover">
        <app-show-cover [artist]="s.artist" />
        <div class="date" aria-hidden="true">
          <span class="day">{{ s.startsAt | showDate: s.venue?.timezone : 'day' }}</span>
          <span class="month">{{ s.startsAt | showDate: s.venue?.timezone : 'month' }}</span>
        </div>
        @if (s.highDemand) {
          <span class="badge">Alta demanda</span>
        }
      </div>
      <div class="body">
        <h3 class="artist">{{ s.artist }}</h3>
        <p class="title">{{ s.title }}</p>
        <p class="meta">
          {{ s.startsAt | showDate: s.venue?.timezone : 'weekday' }},
          {{ s.startsAt | showDate: s.venue?.timezone : 'date' }} às
          {{ s.startsAt | showDate: s.venue?.timezone : 'time' }}
        </p>
        @if (s.venue; as venue) {
          <p class="meta">{{ venue.name }} · {{ venue.city }}/{{ venue.state }}</p>
        }
        <div class="footer">
          @if (s.priceFromCents !== null) {
            <span class="price">
              <small>a partir de</small>
              {{ s.priceFromCents | brl }}
            </span>
          }
          @if (salesOpenLater()) {
            <span class="sales">
              Vendas em {{ s.salesStartAt | showDate: s.venue?.timezone : 'short' }}
            </span>
          }
        </div>
      </div>
    </a>
  `,
  styleUrl: './show-card.scss',
})
export class ShowCard {
  readonly show = input.required<ShowSummary>();

  protected readonly salesOpenLater = computed(() => {
    const salesStartAt = this.show().salesStartAt;
    return salesStartAt !== null && new Date(salesStartAt).getTime() > Date.now();
  });
}

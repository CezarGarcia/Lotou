import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowRight, lucideCalendar, lucideMapPin } from '@ng-icons/lucide';
import { MoneyPipe } from '../../core/format/money.pipe';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { cartazPalette } from '../../shared/ui/cartaz-palette';
import { Show, ShowSummary } from '../data/show.models';
import { SHOWS_URL } from '../data/shows.api';

/**
 * O destaque da página inicial: o cartaz grande do show e, ao lado, o título,
 * a data, o local e o botão de compra. A descrição vem do documento do show,
 * que a busca não traz; sem ela, o destaque fica só com o resumo.
 */
@Component({
  selector: 'app-featured-show',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, Cartaz, MoneyPipe, ShowDatePipe],
  viewProviders: [provideIcons({ lucideArrowRight, lucideCalendar, lucideMapPin })],
  template: `
    @let s = show();
    @let tz = s.venue?.timezone;
    <a
      class="poster"
      [routerLink]="['/shows', s.id]"
      tabindex="-1"
      aria-hidden="true"
      [style.--sombra]="shadow()"
    >
      <app-cartaz
        size="hero"
        [artist]="s.artist"
        [eyebrow]="eyebrow()"
        [date]="s.startsAt"
        [timezone]="tz"
      >
        <p class="display tour">{{ s.title }} · {{ s.startsAt | showDate: tz : 'time' }}</p>
      </app-cartaz>
    </a>

    <div class="text">
      <p class="eyebrow kicker">{{ kicker() }}</p>
      <h2 class="display title">
        <a [routerLink]="['/shows', s.id]">{{ s.title }}</a>
      </h2>
      <p class="artist">{{ s.artist }}</p>
      @if (description(); as description) {
        <p class="description">{{ description }}</p>
      }
      <ul class="pills">
        <li>
          <ng-icon name="lucideCalendar" aria-hidden="true" />
          <span class="cap">
            {{ s.startsAt | showDate: tz : 'full' }} · {{ s.startsAt | showDate: tz : 'time' }}
          </span>
        </li>
        @if (s.venue; as venue) {
          <li>
            <ng-icon name="lucideMapPin" aria-hidden="true" />
            {{ venue.name }}, {{ venue.city }}/{{ venue.state }}
          </li>
        }
      </ul>
      <div class="buy">
        <a class="btn btn-cta btn-lg" [routerLink]="['/shows', s.id]">
          Garantir ingresso
          <ng-icon name="lucideArrowRight" aria-hidden="true" />
        </a>
        @if (s.priceFromCents !== null) {
          <span class="from">
            a partir de <strong class="num">{{ s.priceFromCents | brl }}</strong>
          </span>
        }
      </div>
    </div>
  `,
  styleUrl: './featured-show.scss',
})
export class FeaturedShow {
  readonly show = input.required<ShowSummary>();

  private readonly detail = httpResource<Show>(() => `${SHOWS_URL}/${this.show().id}`);

  protected readonly description = computed(() =>
    this.detail.hasValue() ? this.detail.value().description.trim() : '',
  );

  protected readonly eyebrow = computed(() => {
    const venue = this.show().venue;
    return venue ? `${venue.name} · ${venue.state}` : '';
  });

  protected readonly kicker = computed(() => {
    const { status, salesStartAt, highDemand } = this.show();
    if (status === 'ON_SALE') {
      return highDemand ? 'Em destaque · alta demanda' : 'Em destaque · vendas abertas';
    }
    return salesStartAt ? 'Em destaque · vendas em breve' : 'Em destaque';
  });

  /** A sombra do cartaz tem a cor dele, como uma luz de palco. */
  protected readonly shadow = computed(() => `${cartazPalette(this.show().artist).background}8c`);
}

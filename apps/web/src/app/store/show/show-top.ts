import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft, lucideCalendarX, lucideUsers } from '@ng-icons/lucide';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { cartazPalette } from '../../shared/ui/cartaz-palette';
import { Show } from '../data/show.models';

/**
 * O topo da página do show: o cartaz grande e, ao lado, o nome do artista em
 * letra de cartaz, o título, o local e o carimbo com a data e os horários,
 * sempre no fuso do show. A luz do fundo tem a cor do cartaz.
 */
@Component({
  selector: 'app-show-top',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon, Cartaz, ShowDatePipe],
  viewProviders: [provideIcons({ lucideArrowLeft, lucideCalendarX, lucideUsers })],
  host: { '[style.--luz]': 'light()' },
  template: `
    @let s = show();
    @let tz = s.venue?.timezone;
    <div class="container inner">
      <a routerLink="/" class="back">
        <ng-icon name="lucideArrowLeft" aria-hidden="true" />
        Todos os shows
      </a>

      <div class="grid">
        <app-cartaz
          size="hero"
          [artist]="s.artist"
          [eyebrow]="s.venue ? s.venue.name + ' · ' + s.venue.state : ''"
          [date]="s.startsAt"
          [timezone]="tz"
        >
          <p class="display tour">{{ s.title }}</p>
        </app-cartaz>

        <div class="info">
          <div class="tags">
            @if (s.status === 'CANCELLED') {
              <span class="tag" data-tone="danger">Cancelado</span>
            }
            @if (s.highDemand) {
              <span class="tag" data-tone="info">
                <ng-icon name="lucideUsers" aria-hidden="true" />
                Fila virtual
              </span>
            }
          </div>
          @if (s.venue; as venue) {
            <p class="eyebrow where">{{ venue.name }} · {{ venue.city }}/{{ venue.state }}</p>
          }
          <h1 class="display artist">{{ s.artist }}</h1>
          <p class="display title">{{ s.title }}</p>

          @if (s.status === 'CANCELLED') {
            <p class="cancelled" role="status">
              <ng-icon name="lucideCalendarX" aria-hidden="true" />
              Este show foi cancelado. Quem comprou recebe o reembolso automaticamente.
            </p>
          }

          <div class="stamp">
            <p class="date" aria-hidden="true">
              <span>{{ s.startsAt | showDate: tz : 'weekday' }}</span>
              <strong>{{ s.startsAt | showDate: tz : 'day' }}</strong>
              <span>{{ s.startsAt | showDate: tz : 'month' }}</span>
            </p>
            <div class="times">
              <p class="sr-only">{{ s.startsAt | showDate: tz : 'full' }}</p>
              <p class="start">Show às {{ s.startsAt | showDate: tz : 'time' }}</p>
              @if (s.doorsOpenAt) {
                <p>Portões às {{ s.doorsOpenAt | showDate: tz : 'time' }}</p>
              }
              @if (s.venue; as venue) {
                <p>Horário de {{ venue.city }}</p>
              }
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
  styleUrl: './show-top.scss',
})
export class ShowTop {
  readonly show = input.required<Show>();

  protected readonly light = computed(() => cartazPalette(this.show().artist).background);
}

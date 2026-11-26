import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Show } from '../data/show.models';
import { ShowCover } from './show-cover';

/** Cabeçalho das telas de compra: de qual show se trata, quando e onde. */
@Component({
  selector: 'app-show-heading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ShowCover, ShowDatePipe],
  template: `
    @let s = show();
    @let tz = s.venue?.timezone;
    <a class="cover" [routerLink]="['/shows', s.id]" tabindex="-1" aria-hidden="true">
      <app-show-cover [artist]="s.artist" />
    </a>
    <div class="text">
      <p class="eyebrow">{{ eyebrow() }}</p>
      <h1>
        <a [routerLink]="['/shows', s.id]">{{ s.artist }}</a>
      </h1>
      <p class="meta">
        {{ s.title }} · {{ s.startsAt | showDate: tz : 'date' }} às
        {{ s.startsAt | showDate: tz : 'time' }}
        @if (s.venue; as venue) {
          · {{ venue.name }}, {{ venue.city }}/{{ venue.state }}
        }
      </p>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      gap: 16px;
      align-items: center;
      margin-bottom: 24px;
    }
    .cover {
      display: block;
      text-decoration: none;
      flex: none;
      width: 96px;
      aspect-ratio: 4 / 3;
      overflow: hidden;
      border-radius: 14px;
    }
    .text {
      min-width: 0;
    }
    .eyebrow {
      margin: 0;
      font: var(--mat-sys-label-large);
      color: var(--mat-sys-primary);
      font-weight: 600;
    }
    h1 {
      margin: 2px 0;
      font-size: clamp(1.5rem, 3.5vw, 2.1rem);
      font-weight: 800;
      letter-spacing: -0.02em;
      line-height: 1.1;
    }
    h1 a {
      color: inherit;
      text-decoration: none;
    }
    h1 a:hover {
      text-decoration: underline;
    }
    .meta {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    @media (max-width: 480px) {
      .cover {
        width: 64px;
      }
    }
  `,
})
export class ShowHeading {
  readonly show = input.required<Show>();
  /** O que a tela é: "Fila virtual", "Comprar ingressos"... */
  readonly eyebrow = input.required<string>();
}

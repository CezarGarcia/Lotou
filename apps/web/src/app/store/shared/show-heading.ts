import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { Show } from '../data/show.models';
import { Cartaz } from '../../shared/ui/cartaz';

/** Cabeçalho das telas de compra: de qual show se trata, quando e onde. */
@Component({
  selector: 'app-show-heading',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, Cartaz, ShowDatePipe],
  template: `
    @let s = show();
    @let tz = s.venue?.timezone;
    <a class="cover" [routerLink]="['/shows', s.id]" tabindex="-1" aria-hidden="true">
      <app-cartaz size="mini" [artist]="s.artist" />
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
      gap: 18px;
      align-items: center;
      margin-bottom: 28px;
    }
    .cover {
      display: block;
      flex: none;
      width: 88px;
      height: 110px;
      text-decoration: none;
      transform: rotate(-2deg);
      transition: transform 0.2s var(--lt-ease);
    }
    .cover:hover {
      transform: rotate(0deg) scale(1.03);
    }
    app-cartaz {
      height: 100%;
    }
    .text {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .eyebrow {
      margin: 0;
      color: var(--lt-accent);
    }
    h1 {
      margin: 0;
      font-family: var(--lt-display);
      font-size: clamp(2.25rem, 6vw, 3.5rem);
      font-weight: 900;
      line-height: 0.9;
      text-transform: uppercase;
      text-wrap: balance;
    }
    h1 a {
      color: inherit;
      text-decoration: none;
    }
    h1 a:hover {
      text-decoration: underline;
      text-decoration-thickness: 3px;
    }
    .meta {
      margin: 0;
      color: var(--lt-muted);
    }
    @media (max-width: 480px) {
      .cover {
        width: 64px;
        height: 80px;
      }
    }
  `,
})
export class ShowHeading {
  readonly show = input.required<Show>();
  /** O que a tela é: "Fila virtual", "Comprar ingressos"... */
  readonly eyebrow = input.required<string>();
}

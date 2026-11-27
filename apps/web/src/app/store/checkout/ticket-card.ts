import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatInTimezone } from '../../core/format/show-date.pipe';
import { Cartaz } from '../../shared/ui/cartaz';
import { Show } from '../data/show.models';

/**
 * O cartão do resumo da compra, desenhado como um ingresso: o cartaz do show
 * no topo, a linha picotada com os recortes dos lados e, embaixo, o conteúdo
 * (valores, CPF, botão). O cartaz é decorativo; o show já está no cabeçalho.
 */
@Component({
  selector: 'app-ticket-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Cartaz],
  template: `
    @if (show(); as s) {
      <app-cartaz size="faixa" [artist]="s.artist">
        <span class="when">{{ when() }}</span>
      </app-cartaz>
    } @else {
      <div class="head-placeholder" aria-hidden="true"></div>
    }
    <div class="perf" aria-hidden="true"></div>
    <div class="body">
      <ng-content />
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid var(--lt-line);
      border-radius: var(--lt-radius-lg);
      background: var(--lt-surface);
    }
    app-cartaz {
      min-height: 112px;
      padding: 18px 22px;
      border-radius: 0;
    }
    .when {
      font-family: var(--lt-mono);
      font-size: 0.75rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .head-placeholder {
      height: 112px;
      background: var(--lt-raised);
    }
    .perf {
      position: relative;
      height: 22px;
      flex: none;
      padding-inline: 18px;
      background: linear-gradient(90deg, var(--lt-line-strong) 50%, transparent 50%) 0 50% / 12px
        2px repeat-x content-box;
    }
    .perf::before,
    .perf::after {
      content: '';
      position: absolute;
      top: 0;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--lt-bg);
      box-shadow: inset 0 0 0 1px var(--lt-line);
    }
    .perf::before {
      left: -11px;
    }
    .perf::after {
      right: -11px;
    }
    .body {
      display: grid;
      gap: 16px;
      padding: 4px 22px 22px;
    }
  `,
})
export class TicketCard {
  readonly show = input<Show>();

  /** "sáb 27 dez · 22:00", no fuso do show. */
  protected readonly when = computed(() => {
    const show = this.show();
    if (!show) {
      return '';
    }
    const tz = show.venue?.timezone;
    const part = (format: 'weekday' | 'day' | 'month' | 'time') =>
      formatInTimezone(show.startsAt, tz, format);
    return `${part('weekday')} ${part('day')} ${part('month')} · ${part('time')}`;
  });
}

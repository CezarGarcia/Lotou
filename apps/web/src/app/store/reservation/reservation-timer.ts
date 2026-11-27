import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideTimer } from '@ng-icons/lucide';

/**
 * O cronômetro da reserva, em destaque: o tempo que falta para pagar e a
 * barra que esvazia. Nos dois últimos minutos, fica vermelho e pulsa.
 */
@Component({
  selector: 'app-reservation-timer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideTimer })],
  host: { '[class.warning]': 'warning()' },
  template: `
    <div class="row">
      <div class="text">
        <span class="eyebrow">Sua reserva expira em</span>
        <strong class="clock" role="timer" aria-live="off">{{ clock() }}</strong>
      </div>
      <ng-icon name="lucideTimer" aria-hidden="true" />
    </div>
    <div class="bar" aria-hidden="true">
      <span [style.width.%]="percent()"></span>
    </div>
    <p class="note">
      @if (warning()) {
        Falta pouco: pague agora para não perder os ingressos.
      } @else {
        Os ingressos estão separados para você. Ninguém mais consegue comprá-los.
      }
    </p>
  `,
  styles: `
    :host {
      --tone: var(--lt-cta);
      --tone-soft: var(--lt-warn-soft);
      display: grid;
      gap: 14px;
      padding: 22px 24px;
      border: 1px solid var(--tone);
      border-radius: var(--lt-radius-lg);
      background: linear-gradient(135deg, var(--tone-soft), transparent 70%), var(--lt-surface);
      transition: border-color 0.3s ease;
    }
    :host(.warning) {
      --tone: var(--lt-danger);
      --tone-soft: var(--lt-danger-soft);
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .text {
      display: grid;
      gap: 6px;
    }
    .eyebrow {
      color: var(--lt-text-3);
    }
    .clock {
      color: var(--tone);
      font-family: var(--lt-display);
      font-size: clamp(4rem, 14vw, 6rem);
      font-weight: 900;
      line-height: 0.85;
      font-variant-numeric: tabular-nums;
    }
    :host(.warning) .clock {
      animation: pulse 1s ease-in-out infinite;
    }
    ng-icon {
      font-size: 3rem;
      color: var(--tone);
    }
    .bar {
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--lt-raised);
    }
    .bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--tone);
      transition: width 1s linear;
    }
    .note {
      margin: 0;
      color: var(--lt-text-3);
      font-size: 0.9375rem;
    }
    @keyframes pulse {
      50% {
        opacity: 0.55;
      }
    }
  `,
})
export class ReservationTimer {
  /** "09:41". */
  readonly clock = input.required<string>();
  /** Fração do prazo que resta, de 0 a 100. */
  readonly percent = input.required<number>();
  readonly warning = input(false);
}

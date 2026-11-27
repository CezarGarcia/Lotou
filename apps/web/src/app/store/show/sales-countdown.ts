import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { countdownParts, injectNow } from '../shared/countdown';

/**
 * Contagem regressiva para a abertura das vendas (ou da sala de espera da
 * fila), atualizada a cada segundo.
 */
@Component({
  selector: 'app-sales-countdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ShowDatePipe],
  template: `
    @let parts = remaining();
    @if (parts.done) {
      <p class="open">{{ doneLabel() }}</p>
    } @else {
      <p class="label">
        {{ label() }} em {{ opensAt() | showDate: timezone() : 'full' }}, às
        {{ opensAt() | showDate: timezone() : 'time' }}
      </p>
      <div class="timer" role="timer" [attr.aria-label]="ariaLabel()">
        <div class="unit">
          <strong>{{ parts.days }}</strong><span>{{ parts.days === 1 ? 'dia' : 'dias' }}</span>
        </div>
        <div class="unit">
          <strong>{{ pad(parts.hours) }}</strong><span>horas</span>
        </div>
        <div class="unit">
          <strong>{{ pad(parts.minutes) }}</strong><span>min</span>
        </div>
        <div class="unit">
          <strong>{{ pad(parts.seconds) }}</strong><span>seg</span>
        </div>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .label {
      margin: 0 0 12px;
      color: var(--lt-muted);
      font-size: 0.875rem;
    }
    .open {
      margin: 0;
      font-weight: 700;
      color: var(--lt-ok);
    }
    .timer {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .unit {
      display: grid;
      justify-items: center;
      gap: 4px;
      padding: 12px 4px 10px;
      border-radius: var(--lt-radius-sm);
      background: var(--lt-bg-deep);
      border: 1px solid var(--lt-line);
    }
    strong {
      font-family: var(--lt-display);
      font-size: clamp(2.25rem, 9vw, 3rem);
      font-weight: 900;
      font-variant-numeric: tabular-nums;
      line-height: 0.9;
      color: var(--lt-accent);
    }
    span {
      font-family: var(--lt-mono);
      font-size: 0.6875rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--lt-muted);
    }
  `,
})
export class SalesCountdown {
  /** Instante da abertura das vendas, em ISO 8601. */
  readonly opensAt = input.required<string>();
  readonly timezone = input<string>();
  /** O que acontece no instante: "As vendas abrem", "A sala de espera abre". */
  readonly label = input('As vendas abrem');
  readonly doneLabel = input('Vendas abertas');

  private readonly now = injectNow();

  protected readonly remaining = computed(() =>
    countdownParts(new Date(this.opensAt()).getTime(), this.now()),
  );

  protected readonly ariaLabel = computed(() => {
    const { days, hours, minutes } = this.remaining();
    return `${this.label()} em ${days} dias, ${hours} horas e ${minutes} minutos`;
  });

  protected pad(value: number): string {
    return String(value).padStart(2, '0');
  }
}

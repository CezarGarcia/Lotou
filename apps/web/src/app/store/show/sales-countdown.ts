import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { interval, map } from 'rxjs';
import { ShowDatePipe } from '../../core/format/show-date.pipe';
import { countdownParts } from './countdown';

/** Contagem regressiva para a abertura das vendas, atualizada a cada segundo. */
@Component({
  selector: 'app-sales-countdown',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ShowDatePipe],
  template: `
    @let parts = remaining();
    @if (parts.done) {
      <p class="open">Vendas abertas</p>
    } @else {
      <p class="label">
        As vendas abrem em {{ opensAt() | showDate: timezone() : 'full' }}, às
        {{ opensAt() | showDate: timezone() : 'time' }}
      </p>
      <div class="timer" role="timer" [attr.aria-label]="ariaLabel()">
        <div class="unit">
          <strong>{{ parts.days }}</strong><span>{{ parts.days === 1 ? 'dia' : 'dias' }}</span>
        </div>
        <div class="unit"><strong>{{ pad(parts.hours) }}</strong><span>horas</span></div>
        <div class="unit"><strong>{{ pad(parts.minutes) }}</strong><span>min</span></div>
        <div class="unit"><strong>{{ pad(parts.seconds) }}</strong><span>seg</span></div>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .label {
      margin: 0 0 12px;
      font: var(--mat-sys-body-medium);
      color: var(--mat-sys-on-surface-variant);
    }
    .open {
      margin: 0;
      font: var(--mat-sys-title-medium);
      font-weight: 700;
      color: var(--mat-sys-primary);
    }
    .timer {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .unit {
      display: grid;
      justify-items: center;
      padding: 10px 4px;
      border-radius: 12px;
      background: var(--mat-sys-primary-container);
      color: var(--mat-sys-on-primary-container);
    }
    strong {
      font-size: 1.6rem;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      line-height: 1.1;
    }
    span {
      font: var(--mat-sys-label-small);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
  `,
})
export class SalesCountdown {
  /** Instante da abertura das vendas, em ISO 8601. */
  readonly opensAt = input.required<string>();
  readonly timezone = input<string>();

  private readonly now = toSignal(interval(1000).pipe(map(() => Date.now())), {
    initialValue: Date.now(),
  });

  protected readonly remaining = computed(() =>
    countdownParts(new Date(this.opensAt()).getTime(), this.now()),
  );

  protected readonly ariaLabel = computed(() => {
    const { days, hours, minutes } = this.remaining();
    return `Faltam ${days} dias, ${hours} horas e ${minutes} minutos para a abertura das vendas`;
  });

  protected pad(value: number): string {
    return String(value).padStart(2, '0');
  }
}

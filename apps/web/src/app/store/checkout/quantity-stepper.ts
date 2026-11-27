import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideMinus, lucidePlus } from '@ng-icons/lucide';

/** Quantos ingressos na pista: botões grandes de menos e mais, com o número no meio. */
@Component({
  selector: 'app-quantity-stepper',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideMinus, lucidePlus })],
  template: `
    <span id="quantity-label" class="eyebrow">Quantos ingressos?</span>
    <div class="stepper" role="group" aria-labelledby="quantity-label">
      <button
        type="button"
        aria-label="Menos um ingresso"
        [disabled]="value() <= 1"
        (click)="changed.emit(value() - 1)"
      >
        <ng-icon name="lucideMinus" aria-hidden="true" />
      </button>
      <output aria-live="polite">{{ value() }}</output>
      <button
        type="button"
        aria-label="Mais um ingresso"
        [disabled]="value() >= max()"
        (click)="changed.emit(value() + 1)"
      >
        <ng-icon name="lucidePlus" aria-hidden="true" />
      </button>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      justify-items: center;
      gap: 12px;
    }
    .eyebrow {
      color: var(--lt-muted);
    }
    .stepper {
      display: flex;
      align-items: center;
      gap: clamp(16px, 5vw, 36px);
    }
    output {
      min-width: 2ch;
      font-family: var(--lt-display);
      font-size: 6rem;
      font-weight: 900;
      line-height: 0.9;
      text-align: center;
      font-variant-numeric: tabular-nums;
    }
    button {
      display: grid;
      place-items: center;
      width: 64px;
      height: 64px;
      border: 2px solid var(--lt-line-strong);
      border-radius: 50%;
      background: var(--lt-raised);
      color: var(--lt-text);
      font-size: 1.75rem;
      cursor: pointer;
      transition:
        border-color 0.15s ease,
        transform 0.15s var(--lt-ease);
    }
    button:hover:not(:disabled) {
      border-color: var(--lt-cta);
    }
    button:active:not(:disabled) {
      transform: scale(0.94);
    }
    button:disabled {
      opacity: 0.35;
      cursor: not-allowed;
    }
  `,
})
export class QuantityStepper {
  readonly value = input.required<number>();
  readonly max = input.required<number>();
  /** A quantidade pedida; quem decide se vale é o checkout. */
  readonly changed = output<number>();
}

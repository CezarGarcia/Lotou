import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatInTimezone } from '../../core/format/show-date.pipe';

/**
 * O carimbo de data do cartaz: dia da semana, dia e mês, inclinado como um
 * adesivo colado por cima. As cores vêm do cartaz (`--cartaz-bg` e
 * `--cartaz-ink`), invertidas.
 */
@Component({
  selector: 'app-date-stamp',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="sr-only">{{ label() }}</span>
    <span class="weekday" aria-hidden="true">{{ weekday() }}</span>
    <span class="day" aria-hidden="true">{{ day() }}</span>
    <span class="month" aria-hidden="true">{{ month() }}</span>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      padding: 0.35em 0.55em 0.25em;
      background: var(--cartaz-ink, #121015);
      color: var(--cartaz-bg, #ffd23f);
      font-family: var(--lt-display);
      font-weight: 900;
      text-transform: uppercase;
      line-height: 0.9;
      transform: rotate(4deg);
      font-size: var(--stamp-size, 13px);
    }
    .weekday,
    .month {
      font-weight: 800;
    }
    .day {
      font-size: 2.3em;
    }
  `,
})
export class DateStamp {
  /** Instante em UTC (ISO). */
  readonly date = input.required<string>();
  /** Fuso do show; a data é a do local do show. */
  readonly timezone = input<string>();

  protected readonly weekday = computed(() =>
    formatInTimezone(this.date(), this.timezone(), 'weekday'),
  );
  protected readonly day = computed(() => formatInTimezone(this.date(), this.timezone(), 'day'));
  protected readonly month = computed(() =>
    formatInTimezone(this.date(), this.timezone(), 'month'),
  );
  protected readonly label = computed(() => formatInTimezone(this.date(), this.timezone(), 'full'));
}

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { formatInTimezone } from '../../core/format/show-date.pipe';
import { ACTIVITY_ICONS, describeActivity, relativeTime } from './activity-text';
import { ActivityEntry } from './live.protocol';

/**
 * Feed de atividade, do mais novo ao mais antigo. A lista em si não é uma
 * região ao vivo (cada pedido seria lido em voz alta): os anúncios saem
 * espaçados pela região da página. A área rola e recebe foco pelo teclado.
 */
@Component({
  selector: 'app-activity-feed',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatIconModule],
  template: `
    @if (entries().length === 0) {
      <p class="empty">
        Nenhuma atividade ainda. Pedidos, viradas de lote e entradas aparecem aqui assim que
        acontecem.
      </p>
    } @else {
      <div
        class="scroll"
        tabindex="0"
        role="region"
        aria-label="Atividade recente, da mais nova para a mais antiga"
      >
        <ol>
          @for (entry of entries(); track entry.id) {
            @let text = describe(entry);
            <li [attr.data-type]="entry.type">
              <mat-icon aria-hidden="true">{{ icons[entry.type] }}</mat-icon>
              <span class="what">
                <strong>{{ text.title }}</strong>
                <span>{{ text.detail }}</span>
              </span>
              <time [attr.datetime]="entry.at" [attr.title]="absolute(entry.at)">{{
                relative(entry.at)
              }}</time>
            </li>
          }
        </ol>
      </div>
    }
  `,
  styles: `
    .empty {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
    }
    .scroll {
      max-height: 560px;
      overflow-y: auto;
      border-radius: 16px;
    }
    .scroll:focus-visible {
      outline: 3px solid var(--mat-sys-primary);
      outline-offset: 2px;
    }
    ol {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      align-items: start;
      gap: 12px;
      padding: 12px 4px;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
    li:first-child {
      border-top: 0;
    }
    mat-icon {
      color: var(--mat-sys-primary);
    }
    [data-type='OrderCancelled'] mat-icon {
      color: var(--mat-sys-error);
    }
    [data-type='LotOpened'] mat-icon {
      color: var(--mat-sys-tertiary);
    }
    [data-type='LotSoldOut'] mat-icon {
      color: var(--mat-sys-on-surface-variant);
    }
    [data-type='OrderRefunded'] mat-icon {
      color: var(--mat-sys-tertiary);
    }
    .what {
      display: grid;
      color: var(--mat-sys-on-surface-variant);
    }
    strong {
      color: var(--mat-sys-on-surface);
    }
    time {
      font: var(--mat-sys-body-small);
      color: var(--mat-sys-on-surface-variant);
      white-space: nowrap;
    }
  `,
})
export class ActivityFeed {
  readonly entries = input.required<readonly ActivityEntry[]>();
  /** Relógio da tela, para os tempos relativos andarem sozinhos. */
  readonly now = input.required<number>();
  /** Fuso do show, para a data completa (no `title`) e as entradas com mais de um dia. */
  readonly timezone = input<string>();

  protected readonly icons = ACTIVITY_ICONS;
  protected readonly describe = describeActivity;

  protected relative(instant: string): string {
    return relativeTime(instant, this.now(), this.timezone());
  }

  protected absolute(instant: string): string {
    const tz = this.timezone();
    return `${formatInTimezone(instant, tz, 'date')} às ${formatInTimezone(instant, tz, 'time')}`;
  }
}

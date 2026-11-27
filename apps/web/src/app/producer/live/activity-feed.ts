import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBan,
  lucideCircleX,
  lucideLockOpen,
  lucideRotateCcw,
  lucideScanLine,
  lucideShoppingBag,
} from '@ng-icons/lucide';
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
  imports: [NgIcon],
  viewProviders: [
    provideIcons({
      lucideBan,
      lucideCircleX,
      lucideLockOpen,
      lucideRotateCcw,
      lucideScanLine,
      lucideShoppingBag,
    }),
  ],
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
              <span class="icon"><ng-icon [name]="icons[entry.type]" aria-hidden="true" /></span>
              <span class="what">
                <strong>{{ text.title }}</strong>
                <span>{{ text.detail }}</span>
              </span>
              <time class="mono" [attr.datetime]="entry.at" [attr.title]="absolute(entry.at)">{{
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
      padding: 24px 0;
      color: var(--lt-muted);
    }
    .scroll {
      max-height: 560px;
      margin: -4px -8px;
      padding: 0 8px;
      overflow-y: auto;
      border-radius: 12px;
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
      padding: 10px 0;
      border-top: 1px solid var(--lt-raised);
      --tom: var(--lt-ok);
      --fundo: var(--lt-ok-soft);
    }
    li:first-child {
      border-top: 0;
    }
    .icon {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 9px;
      background: var(--fundo);
      color: var(--tom);
      font-size: 16px;
    }
    [data-type='OrderCancelled'] {
      --tom: var(--lt-danger);
      --fundo: var(--lt-danger-soft);
    }
    [data-type='LotOpened'] {
      --tom: #b0245a;
      --fundo: #ffe1ec;
    }
    [data-type='LotSoldOut'] {
      --tom: var(--lt-text-3);
      --fundo: var(--lt-bg-deep);
    }
    [data-type='TicketCheckedIn'] {
      --tom: var(--lt-info);
      --fundo: var(--lt-info-soft);
    }
    [data-type='OrderRefunded'] {
      --tom: var(--lt-warn);
      --fundo: var(--lt-warn-soft);
    }
    .what {
      display: grid;
      color: var(--lt-muted);
      font-size: 0.8125rem;
    }
    strong {
      color: var(--lt-text);
      font-size: 0.875rem;
      font-weight: 600;
    }
    time {
      padding-top: 2px;
      color: var(--lt-muted);
      font-size: 0.75rem;
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

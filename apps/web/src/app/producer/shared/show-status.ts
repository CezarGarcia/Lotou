import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { SHOW_STATUS_LABELS, label } from './labels';

/**
 * Etiqueta do estado do show no painel. À venda ganha o ponto verde pulsando;
 * as outras cores seguem o tema dia (verde à venda, azul publicado, vermelho
 * cancelado, cinza o resto).
 */
@Component({
  selector: 'app-show-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (status() === 'ON_SALE') {
      <span class="dot" aria-hidden="true"></span>
    }
    {{ text() }}
  `,
  host: { '[attr.data-status]': 'status()' },
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border-radius: 999px;
      background: var(--lt-bg-deep);
      color: var(--lt-text-3);
      font-size: 0.8125rem;
      font-weight: 600;
      line-height: 1.4;
      white-space: nowrap;
    }
    :host([data-status='ON_SALE']) {
      background: var(--lt-ok-soft);
      color: #145c42;
    }
    :host([data-status='PUBLISHED']) {
      background: var(--lt-info-soft);
      color: var(--lt-info);
    }
    :host([data-status='CANCELLED']) {
      background: var(--lt-danger-soft);
      color: var(--lt-danger);
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--lt-ok);
      animation: pulsa 1.8s ease-in-out infinite;
    }
    @keyframes pulsa {
      0%,
      100% {
        box-shadow: 0 0 0 0 rgb(31 138 98 / 0.45);
      }
      50% {
        box-shadow: 0 0 0 6px rgb(31 138 98 / 0);
      }
    }
  `,
})
export class ShowStatus {
  readonly status = input.required<string>();
  protected readonly text = computed(() => label(SHOW_STATUS_LABELS, this.status()));
}

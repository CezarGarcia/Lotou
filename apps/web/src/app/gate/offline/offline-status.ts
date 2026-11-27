import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCloudOff, lucideLogIn, lucideWifi } from '@ng-icons/lucide';
import { formatInTimezone } from '../../core/format/show-date.pipe';

/**
 * A faixa do topo do leitor: se a leitura vai ao servidor ou é decidida no
 * aparelho, de quando é a lista guardada e quantas leituras esperam a rede.
 * Sem internet, fica amarela, como a faixa da loja (ADR 37).
 */
@Component({
  selector: 'app-offline-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideCloudOff, lucideLogIn, lucideWifi })],
  template: `
    <div class="status" role="status" [attr.data-state]="online() ? 'online' : 'offline'">
      <ng-icon [name]="online() ? 'lucideWifi' : 'lucideCloudOff'" aria-hidden="true" />
      <p>
        <strong>{{ online() ? 'Online' : 'Sem internet: validando neste aparelho' }}</strong>
        <span class="mono">{{ details() }}</span>
      </p>
      @if (loginNeeded()) {
        <button type="button" class="login" (click)="login.emit()">
          <ng-icon name="lucideLogIn" aria-hidden="true" />
          Entrar para enviar
        </button>
      }
    </div>
  `,
  styles: `
    .status {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      padding: 6px 6px 6px 12px;
      border-radius: 14px;
      background: var(--lt-surface);
      color: var(--lt-text-2);
      font-size: 0.875rem;

      > ng-icon {
        flex: none;
        color: var(--lt-ok);
        font-size: 18px;
      }

      &[data-state='offline'] {
        background: var(--lt-cta);
        color: var(--lt-on-cta);

        > ng-icon {
          color: inherit;
        }
      }
    }

    p {
      display: flex;
      flex: 1;
      flex-wrap: wrap;
      gap: 0 10px;
      min-width: 0;
      margin: 0;
      line-height: 1.3;
    }

    strong {
      font-weight: 700;
    }

    .mono {
      font-size: 0.75rem;
      letter-spacing: 0.04em;
    }

    .login {
      display: inline-flex;
      flex: none;
      align-items: center;
      gap: 6px;
      min-height: 44px;
      padding: 0 14px;
      border: 0;
      border-radius: 10px;
      background: var(--lt-text);
      color: var(--lt-bg);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
  `,
})
export class OfflineStatus {
  /** A leitura vai ao servidor. */
  readonly online = input(true);
  /** Quando a lista do show foi baixada (UTC); `null` sem lista no aparelho. */
  readonly savedAt = input<string | null>(null);
  readonly timezone = input<string>();
  /** Leituras sem internet esperando o envio. */
  readonly pending = input(0);
  /** Os setores deste portão, quando não são todos. */
  readonly sectors = input<readonly string[]>([]);
  /** A sessão acabou e a fila espera um login para ir. */
  readonly loginNeeded = input(false);
  readonly login = output();

  protected readonly details = computed(() => {
    const savedAt = this.savedAt();
    const pending = this.pending();
    const sectors = this.sectors();
    return [
      savedAt
        ? `lista de ${formatInTimezone(savedAt, this.timezone(), 'time')}`
        : 'sem lista neste aparelho',
      pending > 0 ? `${pending} ${pending === 1 ? 'leitura' : 'leituras'} para enviar` : '',
      sectors.length > 0 ? `só ${sectors.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });
}

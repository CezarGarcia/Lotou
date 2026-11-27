import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * As etapas da compra (escolha, pagamento, ingresso), com a atual marcada.
 * No celular, só a etapa atual mostra o nome; as outras viram o número.
 */
@Component({
  selector: 'app-purchase-steps',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol aria-label="Etapas da compra">
      @for (step of steps(); track step; let i = $index) {
        <li
          [class.done]="i < current()"
          [class.now]="i === current()"
          [attr.aria-current]="i === current() ? 'step' : null"
        >
          <span class="n" aria-hidden="true">{{ i < current() ? '✓' : i + 1 }}</span>
          <span class="label">{{ step }}</span>
        </li>
      }
    </ol>
  `,
  styles: `
    ol {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 0.875rem;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px 4px 4px;
      border-radius: 999px;
      color: var(--lt-muted);
    }
    li + li::before {
      content: '';
      width: 18px;
      height: 2px;
      margin-right: 4px;
      background: var(--lt-line-strong);
    }
    .n {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      border: 1px solid var(--lt-line-strong);
      border-radius: 50%;
      font-family: var(--lt-mono);
      font-size: 0.75rem;
    }
    .done .n {
      border-color: var(--lt-ok);
      color: var(--lt-ok);
    }
    .now {
      background: var(--lt-text);
      color: var(--lt-bg);
      font-weight: 600;
    }
    .now .n {
      border: 0;
      background: var(--lt-bg);
      color: var(--lt-cta);
    }
    @media (max-width: 560px) {
      li:not(.now) .label {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }
      li:not(.now) {
        padding-right: 4px;
      }
    }
  `,
})
export class PurchaseSteps {
  /** A etapa atual, a partir de 0. */
  readonly current = input.required<number>();
  /** Cadeira numerada: a primeira etapa é escolher as cadeiras. */
  readonly seated = input(false);

  protected readonly steps = computed(() => [
    this.seated() ? 'Cadeiras' : 'Ingressos',
    'Pagamento',
    'Ingresso',
  ]);
}

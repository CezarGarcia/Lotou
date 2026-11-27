import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * O botão da compra (reservar, pagar) com o total. No computador, fica no fim
 * do resumo, só o botão; no celular, vira uma barra presa embaixo da tela, com
 * o total ao lado, para o botão estar sempre ao alcance do polegar.
 *
 * O botão entra como conteúdo: continua dentro do formulário e da região do
 * resumo, então é um só em qualquer largura.
 */
@Component({
  selector: 'app-pay-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="total" aria-hidden="true">
      <strong>{{ total() }}</strong>
      <span>{{ caption() }}</span>
    </p>
    <ng-content />
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .total {
      display: grid;
      margin: 0;
      line-height: 1.2;
      font-variant-numeric: tabular-nums;
    }
    strong {
      font-size: 1.375rem;
    }
    span {
      color: var(--lt-muted);
      font-size: 0.875rem;
    }
    @media (min-width: 961px) {
      .total {
        display: none;
      }
    }
    @media (max-width: 960px) {
      :host {
        position: fixed;
        z-index: 20;
        inset: auto 0 0;
        padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
        border-top: 1px solid var(--lt-line-strong);
        background: var(--lt-bg-deep);
        box-shadow: 0 -12px 32px rgb(0 0 0 / 0.4);
      }
      .total {
        flex: 1;
      }
    }
  `,
})
export class PayBar {
  /** O total já formatado ("R$ 240,00"). */
  readonly total = input.required<string>();
  /** A linha de baixo: "2 ingressos". */
  readonly caption = input('');
}

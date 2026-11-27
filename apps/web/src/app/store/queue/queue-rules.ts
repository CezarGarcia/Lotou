import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideShuffle } from '@ng-icons/lucide';

/** A explicação da fila justa: sala de espera, sorteio na abertura e a vez de 5 minutos. */
@Component({
  selector: 'app-queue-rules',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideShuffle })],
  host: { role: 'complementary', 'aria-label': 'Como funciona a fila' },
  template: `
    <p class="eyebrow"><ng-icon name="lucideShuffle" aria-hidden="true" /> Fila justa</p>
    <h2>Como funciona a fila</h2>
    <ol>
      <li>
        A sala de espera abre <strong>30 minutos antes das vendas</strong>. Quem entra nela espera a
        abertura sem posição definida.
      </li>
      <li>
        Na abertura, cada pessoa da sala recebe uma <strong>posição sorteada</strong>. Chegar 30
        minutos antes não dá vantagem sobre quem chegou 1 minuto antes. Quem chega depois da
        abertura entra no fim da fila.
      </li>
      <li>
        Quando chega a sua vez, você tem <strong>5 minutos</strong> para reservar. Depois disso, a
        vez passa para o próximo.
      </li>
    </ol>
  `,
  styles: `
    :host {
      display: block;
      padding: 24px;
      border-top: 4px solid var(--lt-cta);
      border-radius: 0 0 var(--lt-radius) var(--lt-radius);
      background: var(--lt-bg-deep);
    }
    .eyebrow {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 6px;
      color: var(--lt-accent);
    }
    h2 {
      margin: 0 0 16px;
      font-family: var(--lt-display);
      font-size: 1.75rem;
      font-weight: 900;
      text-transform: uppercase;
    }
    ol {
      display: grid;
      gap: 14px;
      margin: 0;
      padding: 0;
      list-style: none;
      counter-reset: step;
      color: var(--lt-text-3);
    }
    li {
      position: relative;
      padding-left: 42px;
      counter-increment: step;
    }
    li::before {
      content: counter(step);
      position: absolute;
      top: 0;
      left: 0;
      color: var(--lt-cta);
      font-family: var(--lt-display);
      font-size: 2rem;
      font-weight: 900;
      line-height: 1;
    }
    strong {
      color: var(--lt-text);
    }
  `,
})
export class QueueRules {}

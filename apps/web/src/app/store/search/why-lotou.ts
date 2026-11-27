import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideQrCode, lucideShuffle, lucideUndo2 } from '@ng-icons/lucide';

/**
 * Por que comprar no Lotou: as três regras do produto que protegem quem
 * compra (fila virtual com sorteio, cancelamento em 7 dias e QR assinado).
 * Os textos seguem as regras de `docs/projeto.md`.
 */
@Component({
  selector: 'app-why-lotou',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon],
  viewProviders: [provideIcons({ lucideQrCode, lucideShuffle, lucideUndo2 })],
  template: `
    <h2 class="sr-only">Por que comprar no Lotou</h2>
    <ul>
      <li class="panel">
        <ng-icon name="lucideShuffle" aria-hidden="true" />
        <div>
          <h3>Fila justa nos shows lotados</h3>
          <p>
            A sala de espera abre 30 minutos antes e as posições são sorteadas na abertura. Chegar
            cedo não dá vantagem, nem para robô.
          </p>
        </div>
      </li>
      <li class="panel">
        <ng-icon name="lucideUndo2" aria-hidden="true" />
        <div>
          <h3>Desistiu? Até 7 dias</h3>
          <p>
            Cancele em Meus ingressos se faltarem mais de 48 h para o show. O reembolso é integral,
            com a taxa.
          </p>
        </div>
      </li>
      <li class="panel">
        <ng-icon name="lucideQrCode" aria-hidden="true" />
        <div>
          <h3>Ingresso que não se falsifica</h3>
          <p>
            O QR code é assinado: código inventado é recusado na porta, e cada ingresso libera uma
            entrada só.
          </p>
        </div>
      </li>
    </ul>
  `,
  styles: `
    :host {
      display: block;
    }
    ul {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
      gap: 16px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      display: flex;
      align-items: flex-start;
      gap: 16px;
      padding: 22px;
    }
    ng-icon {
      font-size: 28px;
      color: var(--lt-accent);
    }
    h3 {
      margin: 0 0 4px;
      font-size: 1.0625rem;
      font-weight: 700;
    }
    p {
      margin: 0;
      color: var(--lt-muted);
      font-size: 0.9375rem;
    }
  `,
})
export class WhyLotou {}

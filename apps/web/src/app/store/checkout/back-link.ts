import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideArrowLeft } from '@ng-icons/lucide';

/** O link de voltar das telas de compra e do pedido ("Voltar ao show", "Meus ingressos"). */
@Component({
  selector: 'app-back-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon],
  viewProviders: [provideIcons({ lucideArrowLeft })],
  template: `
    <a [routerLink]="link()">
      <ng-icon name="lucideArrowLeft" aria-hidden="true" />
      {{ label() }}
    </a>
  `,
  styles: `
    :host {
      display: block;
    }
    a {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 44px;
      color: var(--lt-text-2);
      font-weight: 600;
      text-decoration: none;
    }
    a:hover {
      color: var(--lt-accent);
    }
  `,
})
export class BackLink {
  readonly link = input.required<string | readonly unknown[]>();
  readonly label = input.required<string>();
}

import { ChangeDetectionStrategy, Component } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { RouterLink } from '@angular/router';

/** Quem entrou sem o papel de produtor e tentou abrir o painel. */
@Component({
  selector: 'app-no-access-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MatButtonModule, MatIconModule],
  template: `
    <div class="container page">
      <section class="state" role="alert">
        <mat-icon aria-hidden="true">lock</mat-icon>
        <h1>Acesso restrito</h1>
        <p>O painel é só para produtores. Sua conta não tem esse acesso.</p>
        <a matButton="filled" routerLink="/">Ver os shows</a>
      </section>
    </div>
  `,
  styles: `
    .page {
      padding-block: 48px 64px;
    }
    .state {
      display: grid;
      justify-items: center;
      gap: 12px;
      max-width: 520px;
      margin-inline: auto;
      padding: 48px 24px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 20px;
      background: var(--mat-sys-surface-container-lowest);
      text-align: center;
    }
    mat-icon {
      width: 48px;
      height: 48px;
      font-size: 48px;
      color: var(--mat-sys-outline);
    }
    h1 {
      margin: 0;
      font: var(--mat-sys-headline-small);
      font-weight: 700;
    }
    p {
      margin: 0 0 8px;
      color: var(--mat-sys-on-surface-variant);
    }
  `,
})
export class NoAccessPage {}

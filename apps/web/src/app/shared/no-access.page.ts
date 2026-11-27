import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLock } from '@ng-icons/lucide';

/**
 * Quem entrou sem o papel da área (produtor ou portaria) e tentou abri-la. O
 * texto vem do `data` da rota, como input. As cores vêm dos tokens, então a
 * tela segue o tema da área que a abriu (dia no painel, noite na portaria).
 */
@Component({
  selector: 'app-no-access-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NgIcon],
  viewProviders: [provideIcons({ lucideLock })],
  template: `
    <div class="container page">
      <section class="state" role="alert">
        <span class="icon"><ng-icon name="lucideLock" aria-hidden="true" /></span>
        <h1 class="display">Acesso restrito</h1>
        <p class="message">{{ message() }}</p>
        <a class="btn btn-cta" routerLink="/">Ver os shows</a>
      </section>
    </div>
  `,
  styles: `
    .page {
      padding-block: 56px 72px;
    }
    .state {
      display: grid;
      justify-items: center;
      gap: 12px;
      max-width: 520px;
      margin-inline: auto;
      padding: 48px 24px;
      border: 1px solid var(--lt-line);
      border-radius: var(--lt-radius-lg);
      background: var(--lt-surface);
      text-align: center;
    }
    .icon {
      display: grid;
      place-items: center;
      width: 72px;
      height: 72px;
      margin-bottom: 4px;
      border-radius: 50%;
      background: var(--lt-danger-soft);
      color: var(--lt-danger);
      font-size: 32px;
    }
    p {
      margin: 0;
    }
    .eyebrow {
      color: var(--lt-muted);
    }
    h1 {
      margin: 0;
      font-size: clamp(2.5rem, 8vw, 3.5rem);
    }
    .message {
      margin-bottom: 12px;
      color: var(--lt-text-3);
    }
  `,
})
export class NoAccessPage {
  readonly message = input('Sua conta não tem acesso a esta área.');
}

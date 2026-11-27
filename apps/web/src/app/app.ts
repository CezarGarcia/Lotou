import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideHouse,
  lucideLogIn,
  lucideLogOut,
  lucideSearch,
  lucideTicket,
} from '@ng-icons/lucide';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './core/auth/auth.service';
import { AppArea } from './core/ui/app-area';
import { NetworkStatus } from './core/ui/network-status';
import { clearSavedTickets } from './store/wallet/wallet-key';
import { Logo } from './shared/ui/logo';

/**
 * Moldura da aplicação: cabeçalho (um por área: loja, painel e portaria), a
 * área da rota, o rodapé e, no celular, a barra de abas da loja.
 *
 * O cabeçalho não usa componentes do Material de propósito: ele entra no
 * pacote inicial, e o Material fica nos pacotes das telas. O menu da conta é
 * um `popover` nativo do navegador.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, NgIcon, Logo],
  viewProviders: [
    provideIcons({ lucideHouse, lucideLogIn, lucideLogOut, lucideSearch, lucideTicket }),
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly router = inject(Router);
  protected readonly auth = inject(AuthService);
  protected readonly area = inject(AppArea);
  protected readonly network = inject(NetworkStatus);
  private readonly injector = inject(Injector);

  protected readonly initial = computed(() => this.auth.firstName().charAt(0).toUpperCase());

  constructor() {
    // Com login e internet, os ingressos dos próximos shows ficam guardados no
    // aparelho para abrir sem sinal (ADR 37). Uma vez por login ou por volta da rede.
    effect(() => {
      const userId = this.auth.userId();
      if (!userId || !this.network.online()) {
        return;
      }
      // A carteira é carregada sob demanda: fica fora do pacote inicial.
      untracked(
        () =>
          void import('./store/wallet/ticket-wallet').then(({ TicketWallet }) => {
            const wallet = this.injector.get(TicketWallet);
            wallet.forgetOthers(userId);
            wallet.sync(userId).subscribe();
          }),
      );
    });
  }

  protected logout(): void {
    // Os ingressos saem do aparelho junto com a sessão.
    clearSavedTickets(globalThis.localStorage);
    this.auth.logout();
  }

  protected search(event: Event, artist: string): void {
    event.preventDefault();
    const value = artist.trim();
    void this.router.navigate(['/'], { queryParams: value ? { artist: value } : {} });
  }

  protected closeMenu(): void {
    document.getElementById('menu-conta')?.hidePopover();
  }
}

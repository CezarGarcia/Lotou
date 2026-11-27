import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
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

  protected readonly initial = computed(() => this.auth.firstName().charAt(0).toUpperCase());

  protected search(event: Event, artist: string): void {
    event.preventDefault();
    const value = artist.trim();
    void this.router.navigate(['/'], { queryParams: value ? { artist: value } : {} });
  }

  protected closeMenu(): void {
    document.getElementById('menu-conta')?.hidePopover();
  }
}

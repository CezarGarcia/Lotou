import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { Role, rolesFromAccessToken } from './auth.claims';
import { AuthService } from './auth.service';

/**
 * Guard das áreas restritas a um papel (painel do produtor, portaria). Sem
 * login, leva ao Keycloak e volta à mesma página; com login mas sem o papel,
 * abre a tela de acesso restrito da área.
 *
 * O papel é lido do token atual, não do signal de papéis: numa primeira
 * navegação, o signal pode ainda não ter recebido o token.
 *
 * Isto só decide o que a loja mostra. Quem protege os dados é o servidor: o
 * gateway e os serviços conferem o papel no token a cada chamada.
 */
export function roleGuard(role: Role, deniedUrl: string): CanActivateFn {
  return (_route, state) => {
    const auth = inject(AuthService);
    const router = inject(Router);
    if (!auth.authenticated()) {
      auth.login(state.url);
      return false;
    }
    return auth
      .accessToken()
      .pipe(
        map((token) =>
          rolesFromAccessToken(token).includes(role) ? true : router.parseUrl(deniedUrl),
        ),
      );
  };
}

import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { rolesFromAccessToken } from '../core/auth/auth.claims';
import { AuthService } from '../core/auth/auth.service';

/**
 * Telas do produtor. Sem login, leva ao Keycloak e volta à mesma página; com
 * login mas sem o papel `producer`, mostra a tela de acesso restrito.
 *
 * O papel é lido do token atual, não do signal de papéis: numa primeira
 * navegação, o signal pode ainda não ter recebido o token.
 *
 * Isto só decide o que a loja mostra. Quem protege os dados é o servidor: o
 * gateway e o analytics conferem o papel no token a cada chamada.
 */
export const producerGuard: CanActivateFn = (_route, state) => {
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
        rolesFromAccessToken(token).includes('producer')
          ? true
          : router.createUrlTree(['/painel/sem-acesso']),
      ),
    );
};

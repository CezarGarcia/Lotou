import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

/**
 * Telas do comprador. Sem login, leva ao Keycloak e, na volta, abre a página
 * que ele queria (com os parâmetros, como `/shows/1/fila?setor=2`).
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  if (auth.authenticated()) {
    return true;
  }
  auth.login(state.url);
  return false;
};

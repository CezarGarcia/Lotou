import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { NetworkStatus } from '../ui/network-status';
import { AuthService } from './auth.service';

/** A página que abre sem internet e sem login (ADR 37). */
export const SAVED_TICKETS_URL = '/ingressos-salvos';

/**
 * Telas do comprador. Sem login, leva ao Keycloak e, na volta, abre a página
 * que ele queria (com os parâmetros, como `/shows/1/fila?setor=2`).
 *
 * Sem internet, o Keycloak não abre e nada dessas telas funciona: o comprador
 * vai para os ingressos salvos no aparelho.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const auth = inject(AuthService);
  if (!inject(NetworkStatus).online()) {
    return inject(Router).parseUrl(SAVED_TICKETS_URL);
  }
  if (auth.authenticated()) {
    return true;
  }
  auth.login(state.url);
  return false;
};

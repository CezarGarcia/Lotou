import { Injector, inject, runInInjectionContext } from '@angular/core';
import { CanActivateFn, GuardResult, MaybeAsync } from '@angular/router';
import { Observable, from, isObservable, of, switchMap } from 'rxjs';
import { roleGuard } from '../core/auth/role.guard';
import { NetworkStatus } from '../core/ui/network-status';
import { GATE_OFFLINE_DB } from './offline/gate-offline-db';

const staffOnly = roleGuard('gate-staff', '/portaria/sem-acesso');

/**
 * Telas da portaria. Sem login, leva ao Keycloak e volta à mesma página; com
 * login mas sem o papel `gate-staff`, mostra a tela de acesso restrito. Quem
 * protege os dados é o servidor: o gateway e o checkin-service conferem o papel.
 *
 * Sem internet, o Keycloak não abre (e o token não sobrevive ao fechamento do
 * app, ADR 37). O leitor de um show abre assim mesmo se o aparelho tem o
 * pacote offline dele (ADR 38), e a escolha do show abre se há algum pacote:
 * mandar para o login seria deixar a portaria parada. O pacote não tem dado
 * pessoal, e as leituras feitas assim só valem quando enviadas com login.
 */
export const gateGuard: CanActivateFn = (route, state) => {
  const injector = inject(Injector);
  const withRole = () => runInInjectionContext(injector, () => staffOnly(route, state));
  if (inject(NetworkStatus).online()) {
    return withRole();
  }
  const db = inject(GATE_OFFLINE_DB);
  const showId = route.paramMap.get('showId');
  const stored = showId
    ? db.hasPackage(showId)
    : db.storedShows().then((shows) => shows.length > 0);
  return from(stored.catch(() => false)).pipe(
    switchMap((found) => (found ? of(true) : asObservable(withRole()))),
  );
};

function asObservable(result: MaybeAsync<GuardResult>): Observable<GuardResult> {
  if (isObservable(result)) {
    return result;
  }
  return result instanceof Promise ? from(result) : of(result);
}

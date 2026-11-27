import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { NetworkStatus } from '../ui/network-status';
import { SAVED_TICKETS_URL, authGuard } from './auth.guard';
import { AuthService } from './auth.service';

describe('authGuard', () => {
  const online = signal(true);
  const authenticated = signal(false);
  const login = vi.fn();

  function run(url: string) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { authenticated, login } },
        { provide: NetworkStatus, useValue: { online } },
      ],
    });
    return TestBed.runInInjectionContext(() =>
      authGuard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
    );
  }

  beforeEach(() => login.mockReset());

  it('sem login, leva ao Keycloak e volta para a página pedida', () => {
    online.set(true);
    authenticated.set(false);
    expect(run('/meus-ingressos')).toBe(false);
    expect(login).toHaveBeenCalledWith('/meus-ingressos');
  });

  it('sem internet, abre os ingressos salvos em vez de tentar o login', () => {
    online.set(false);
    authenticated.set(false);
    const result = run('/meus-ingressos') as UrlTree;
    expect(TestBed.inject(Router).serializeUrl(result)).toBe(SAVED_TICKETS_URL);
    expect(login).not.toHaveBeenCalled();
  });

  it('com login e internet, deixa passar', () => {
    online.set(true);
    authenticated.set(true);
    expect(run('/meus-ingressos')).toBe(true);
  });
});

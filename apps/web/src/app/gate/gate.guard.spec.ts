import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { Observable, firstValueFrom, isObservable, of } from 'rxjs';
import { AuthService } from '../core/auth/auth.service';
import { gateGuard } from './gate.guard';

/** Um JWT de teste com os papéis do realm (a assinatura não importa no navegador). */
function jwt(roles: string[]): string {
  const payload = btoa(JSON.stringify({ realm_access: { roles } }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${payload}.assinatura`;
}

describe('gateGuard', () => {
  async function run(authenticated: boolean, token = '') {
    const login = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: { authenticated: () => authenticated, login, accessToken: () => of(token) },
        },
      ],
    });
    const result = TestBed.runInInjectionContext(() =>
      gateGuard(
        {} as ActivatedRouteSnapshot,
        { url: '/portaria/shows/s1?portao=B' } as RouterStateSnapshot,
      ),
    );
    const value = isObservable(result)
      ? await firstValueFrom(result as Observable<boolean | UrlTree>)
      : result;
    return { value, login };
  }

  it('deixa passar a equipe da portaria', async () => {
    const { value } = await run(true, jwt(['gate-staff']));
    expect(value).toBe(true);
  });

  it('leva ao login sem sessão, voltando ao leitor com o portão', async () => {
    const { value, login } = await run(false);
    expect(value).toBe(false);
    expect(login).toHaveBeenCalledWith('/portaria/shows/s1?portao=B');
  });

  it.each([[['buyer']], [['producer']], [[]]])(
    'manda quem não é da portaria (%j) para a tela de acesso restrito',
    async (roles) => {
      const { value } = await run(true, jwt(roles));
      expect(value).toBeInstanceOf(UrlTree);
      expect(TestBed.inject(Router).serializeUrl(value as UrlTree)).toBe('/portaria/sem-acesso');
    },
  );
});

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
import { producerGuard } from './producer.guard';

/** Um JWT de teste com os papéis do realm (a assinatura não importa no navegador). */
function jwt(roles: string[]): string {
  const payload = btoa(JSON.stringify({ realm_access: { roles } }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${payload}.assinatura`;
}

describe('producerGuard', () => {
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
      producerGuard(
        {} as ActivatedRouteSnapshot,
        { url: '/painel/shows/s1' } as RouterStateSnapshot,
      ),
    );
    const value = isObservable(result)
      ? await firstValueFrom(result as Observable<boolean | UrlTree>)
      : result;
    return { value, login };
  }

  it('deixa passar quem tem o papel de produtor', async () => {
    const { value, login } = await run(true, jwt(['buyer', 'producer']));
    expect(value).toBe(true);
    expect(login).not.toHaveBeenCalled();
  });

  it('leva ao login sem sessão, voltando à mesma página do painel', async () => {
    const { value, login } = await run(false);
    expect(value).toBe(false);
    expect(login).toHaveBeenCalledWith('/painel/shows/s1');
  });

  it('manda o comprador sem o papel para a tela de acesso restrito', async () => {
    const { value, login } = await run(true, jwt(['buyer']));
    const router = TestBed.inject(Router);
    expect(value).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(value as UrlTree)).toBe('/painel/sem-acesso');
    expect(login).not.toHaveBeenCalled();
  });

  it('token ilegível conta como sem o papel', async () => {
    const { value } = await run(true, 'lixo');
    expect(value).toBeInstanceOf(UrlTree);
  });
});

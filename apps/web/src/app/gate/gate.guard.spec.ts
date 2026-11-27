import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import { Observable, firstValueFrom, isObservable, of } from 'rxjs';
import { AuthService } from '../core/auth/auth.service';
import { NetworkStatus } from '../core/ui/network-status';
import { gateGuard } from './gate.guard';
import { GATE_OFFLINE_DB, MemoryGateOfflineDb } from './offline/gate-offline-db';
import { testPackage } from './offline/offline.testing';

/** Um JWT de teste com os papéis do realm (a assinatura não importa no navegador). */
function jwt(roles: string[]): string {
  const payload = btoa(JSON.stringify({ realm_access: { roles } }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `cabecalho.${payload}.assinatura`;
}

describe('gateGuard', () => {
  async function run(
    authenticated: boolean,
    token = '',
    { online = true, db = new MemoryGateOfflineDb(), showId = 's1' as string | null } = {},
  ) {
    const login = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: { authenticated: () => authenticated, login, accessToken: () => of(token) },
        },
        { provide: NetworkStatus, useValue: { online: () => online } },
        { provide: GATE_OFFLINE_DB, useValue: db },
      ],
    });
    const route = { paramMap: convertToParamMap(showId ? { showId } : {}) };
    const result = TestBed.runInInjectionContext(() =>
      gateGuard(
        route as ActivatedRouteSnapshot,
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

  describe('sem internet', () => {
    async function withPackage() {
      const db = new MemoryGateOfflineDb();
      await db.savePackage({
        showId: 's1',
        savedAt: '2026-12-16T23:31:00Z',
        pkg: testPackage('chave'),
        show: {
          showId: 's1',
          title: 'Turnê',
          artist: 'Banda',
          startsAt: '2026-12-17T00:00:00Z',
          timezone: 'America/Recife',
          doorsOpenAt: null,
          venueName: 'Arena',
        },
      });
      return db;
    }

    it('abre o leitor do show com pacote guardado, sem mandar para o login', async () => {
      const { value, login } = await run(false, '', { online: false, db: await withPackage() });
      expect(value).toBe(true);
      expect(login).not.toHaveBeenCalled();
    });

    it('abre a escolha do show se há algum pacote guardado', async () => {
      const { value } = await run(false, '', {
        online: false,
        db: await withPackage(),
        showId: null,
      });
      expect(value).toBe(true);
    });

    it('sem pacote do show, segue a regra de sempre', async () => {
      const { value, login } = await run(false, '', { online: false });
      expect(value).toBe(false);
      expect(login).toHaveBeenCalled();
      const staff = await run(true, jwt(['gate-staff']), { online: false });
      expect(staff.value).toBe(true);
    });
  });
});

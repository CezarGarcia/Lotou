import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { of } from 'rxjs';
import { firstNameOf, rolesFromAccessToken, safeReturnUrl } from './auth.claims';
import { authGuard } from './auth.guard';
import { authInterceptor, isApiUrl } from './auth.interceptor';
import { AuthService } from './auth.service';

/** Um JWT de teste (a assinatura não importa para o navegador). */
function jwt(payload: object): string {
  const encode = (value: object) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${encode({ alg: 'RS256' })}.${encode(payload)}.assinatura`;
}

describe('isApiUrl', () => {
  const origin = 'http://localhost:4200';

  it('aceita só /api/ no mesmo domínio da loja', () => {
    expect(isApiUrl('/api/v1/orders', origin)).toBe(true);
    expect(isApiUrl('http://localhost:4200/api/v1/orders', origin)).toBe(true);
    expect(isApiUrl('/api', origin)).toBe(false);
    expect(isApiUrl('/apis/x', origin)).toBe(false);
    expect(isApiUrl('/otlp/v1/traces', origin)).toBe(false);
    expect(
      isApiUrl('http://localhost:8180/realms/lotou/protocol/openid-connect/token', origin),
    ).toBe(false);
    expect(isApiUrl('https://outro.site/api/v1/orders', origin)).toBe(false);
    expect(isApiUrl('//outro.site/api/v1/orders', origin)).toBe(false);
  });
});

describe('authInterceptor', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  const token = signal('token-abc');

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { accessToken: () => of(token()) } },
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => backend.verify());

  it('põe o Bearer nas chamadas à API', () => {
    http.get('/api/v1/orders').subscribe();
    expect(backend.expectOne('/api/v1/orders').request.headers.get('Authorization')).toBe(
      'Bearer token-abc',
    );
  });

  it('não manda o token para fora da API', () => {
    http.get('/otlp/v1/traces').subscribe();
    http.get('https://outro.site/api/v1/orders').subscribe();
    http.get('http://localhost:8180/realms/lotou/account').subscribe();

    for (const request of backend.match(() => true)) {
      expect(request.request.headers.has('Authorization')).toBe(false);
    }
  });

  it('segue sem cabeçalho quando não há login', () => {
    token.set('');
    http.get('/api/v1/shows').subscribe();
    expect(backend.expectOne('/api/v1/shows').request.headers.has('Authorization')).toBe(false);
    token.set('token-abc');
  });
});

describe('authGuard', () => {
  const run = (authenticated: boolean) => {
    const login = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: { authenticated: () => authenticated, login } },
      ],
    });
    const result = TestBed.runInInjectionContext(() =>
      authGuard(
        {} as ActivatedRouteSnapshot,
        { url: '/shows/1/fila?setor=2' } as RouterStateSnapshot,
      ),
    );
    return { result, login };
  };

  it('deixa passar quem está logado', () => {
    const { result, login } = run(true);
    expect(result).toBe(true);
    expect(login).not.toHaveBeenCalled();
  });

  it('leva ao login guardando a página que o comprador queria', () => {
    const { result, login } = run(false);
    expect(result).toBe(false);
    expect(login).toHaveBeenCalledWith('/shows/1/fila?setor=2');
  });
});

describe('claims', () => {
  it('lê os papéis do realm no access token', () => {
    expect(
      rolesFromAccessToken(jwt({ realm_access: { roles: ['buyer', 'offline_access'] } })),
    ).toEqual(['buyer', 'offline_access']);
    expect(rolesFromAccessToken(jwt({ sub: '1' }))).toEqual([]);
    expect(rolesFromAccessToken('lixo')).toEqual([]);
    expect(rolesFromAccessToken('')).toEqual([]);
  });

  it('decodifica nomes com acento', () => {
    expect(firstNameOf({ given_name: 'Bia' })).toBe('Bia');
    expect(firstNameOf({ name: 'Ângela Souza' })).toBe('Ângela');
    expect(rolesFromAccessToken(jwt({ name: 'João', realm_access: { roles: ['buyer'] } }))).toEqual(
      ['buyer'],
    );
    expect(firstNameOf({ preferred_username: 'comprador' })).toBe('comprador');
    expect(firstNameOf(null)).toBe('');
  });

  it('só aceita caminhos internos como volta do login', () => {
    expect(safeReturnUrl('/pedidos/1')).toBe('/pedidos/1');
    expect(safeReturnUrl('//outro.site')).toBeNull();
    expect(safeReturnUrl('/\\outro.site')).toBeNull();
    expect(safeReturnUrl('https://outro.site')).toBeNull();
    expect(safeReturnUrl(null)).toBeNull();
  });
});

import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { Observable, catchError, map, of, switchMap, take, tap, timeout } from 'rxjs';
import { Role, firstNameOf, rolesFromAccessToken, safeReturnUrl } from './auth.claims';

/** Onde fica, durante o login, a página que o comprador queria abrir. */
const RETURN_URL_KEY = 'lotou.auth.returnUrl';

/**
 * Login com o Keycloak (OpenID Connect, Authorization Code + PKCE), por cima do
 * `angular-auth-oidc-client`. O resto da loja só conhece este serviço: se está
 * logado, o primeiro nome, os papéis e o access token para a API.
 *
 * Tokens, e-mail e CPF nunca vão para log nem para a telemetria.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly oidc = inject(OidcSecurityService);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  readonly authenticated = computed(() => this.oidc.authenticated().isAuthenticated);
  readonly firstName = computed(() =>
    this.authenticated() ? firstNameOf(this.oidc.userData().userData) : '',
  );

  /** Papéis do realm, lidos do access token a cada login ou renovação. */
  readonly roles = toSignal(
    this.oidc.isAuthenticated$.pipe(
      switchMap(({ isAuthenticated }) => (isAuthenticated ? this.accessToken() : of(''))),
      map(rolesFromAccessToken),
    ),
    { initialValue: [] as string[] },
  );

  hasRole(role: Role): boolean {
    return this.roles().includes(role);
  }

  /** O access token atual, ou vazio sem login. */
  accessToken(): Observable<string> {
    return this.oidc.getAccessToken().pipe(take(1));
  }

  /**
   * Roda antes da primeira rota: lê a sessão guardada ou, na volta do Keycloak,
   * troca o código pelos tokens e leva o comprador à página que ele queria.
   * Se o Keycloak estiver fora do ar, a loja abre do mesmo jeito, sem login.
   */
  start(): Observable<unknown> {
    const search = this.document.location?.search ?? '';
    const isCallback = /[?&]code=/.test(search) && /[?&]state=/.test(search);
    return this.oidc.checkAuth().pipe(
      timeout(10_000),
      tap(({ isAuthenticated }) => {
        if (!isCallback) {
          return;
        }
        const returnUrl = this.takeReturnUrl();
        // Sem página guardada, a URL ficaria com ?code=...&state=...; volta à home.
        void this.router.navigateByUrl(isAuthenticated && returnUrl ? returnUrl : '/', {
          replaceUrl: true,
        });
      }),
      catchError(() => of(null)),
    );
  }

  /** Vai ao Keycloak; na volta, abre `returnUrl` (por padrão, a página atual). */
  login(returnUrl = this.router.url): void {
    this.storage()?.setItem(RETURN_URL_KEY, safeReturnUrl(returnUrl) ?? '/');
    this.oidc.authorize();
  }

  /** Encerra a sessão no Keycloak e volta para a loja. */
  logout(): void {
    this.oidc.logoff().subscribe();
  }

  private takeReturnUrl(): string | null {
    const storage = this.storage();
    const url = storage?.getItem(RETURN_URL_KEY);
    storage?.removeItem(RETURN_URL_KEY);
    return safeReturnUrl(url);
  }

  private storage(): Storage | undefined {
    try {
      return this.document.defaultView?.sessionStorage;
    } catch {
      return undefined;
    }
  }
}

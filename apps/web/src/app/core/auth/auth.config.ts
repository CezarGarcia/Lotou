import { isDevMode } from '@angular/core';
import { LogLevel, OpenIdConfiguration } from 'angular-auth-oidc-client';

/**
 * Onde o login acontece. É o único lugar com endereços do Keycloak e da loja:
 * para rodar em outro domínio, mude aqui e no cliente `lotou-web` do realm
 * (redirect URIs e web origins).
 */
export const AUTH_SETTINGS = {
  /** Realm do Keycloak; o mesmo emissor que o gateway confere no token. */
  authority: 'http://localhost:8180/realms/lotou',
  /** Cliente público: sem segredo no navegador, autenticado com PKCE. */
  clientId: 'lotou-web',
  /** Para onde o Keycloak devolve o comprador depois do login e do logout. */
  redirectUrl: 'http://localhost:4200/',
  scope: 'openid profile email',
} as const;

/**
 * Authorization Code com PKCE, com renovação do token por refresh token (sem
 * iframe). O access token dura 5 minutos no realm; a biblioteca o renova 30 s
 * antes de vencer.
 */
export const OIDC_CONFIG: OpenIdConfiguration = {
  authority: AUTH_SETTINGS.authority,
  clientId: AUTH_SETTINGS.clientId,
  redirectUrl: AUTH_SETTINGS.redirectUrl,
  postLogoutRedirectUri: AUTH_SETTINGS.redirectUrl,
  scope: AUTH_SETTINGS.scope,
  responseType: 'code',
  silentRenew: true,
  useRefreshToken: true,
  renewTimeBeforeTokenExpiresInSeconds: 30,
  // Nome e e-mail vêm do ID token; não precisa chamar o userinfo.
  autoUserInfo: false,
  // A volta do login é tratada pelo AuthService, que leva o comprador à página que ele queria.
  triggerAuthorizationResultEvent: true,
  // Os logs de depuração da biblioteca mostram tokens: nunca em produção.
  logLevel: isDevMode() ? LogLevel.Warn : LogLevel.None,
};

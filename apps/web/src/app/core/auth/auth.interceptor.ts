import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { switchMap } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * Se a URL é da API do Lotou: `/api/...` no mesmo domínio da loja. O token
 * nunca vai para outro domínio, nem para `/otlp` ou para o próprio Keycloak.
 */
export function isApiUrl(url: string, origin = globalThis.location?.origin): boolean {
  if (!origin) {
    return url.startsWith('/api/');
  }
  try {
    const target = new URL(url, origin);
    return target.origin === origin && target.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/** O cabeçalho de autorização para uma URL, ou nenhum. */
export function bearer(url: string, token: string): Record<string, string> {
  return token && isApiUrl(url) ? { Authorization: `Bearer ${token}` } : {};
}

/** Põe `Authorization: Bearer` nas chamadas à API, e só nelas. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiUrl(req.url)) {
    return next(req);
  }
  return inject(AuthService)
    .accessToken()
    .pipe(
      switchMap((token) =>
        next(token ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : req),
      ),
    );
};

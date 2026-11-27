import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import localePt from '@angular/common/locales/pt';
import {
  ApplicationConfig,
  LOCALE_ID,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withViewTransitions,
} from '@angular/router';
import { provideNgIconsConfig } from '@ng-icons/core';
import { provideAuth } from 'angular-auth-oidc-client';
import { routes } from './app.routes';
import { OIDC_CONFIG } from './core/auth/auth.config';
import { authInterceptor } from './core/auth/auth.interceptor';
import { AuthService } from './core/auth/auth.service';

registerLocaleData(localePt);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(
      routes,
      // Parâmetros de rota e de query chegam aos componentes como inputs.
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
      // Troca de tela com a View Transitions API do navegador (sem biblioteca).
      withViewTransitions({ skipInitialTransition: true }),
    ),
    // fetch em vez de XHR: é o que o OpenTelemetry instrumenta melhor.
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideAuth({ config: OIDC_CONFIG }),
    // A sessão (ou a volta do login) é resolvida antes da primeira rota.
    provideAppInitializer(() => inject(AuthService).start()),
    { provide: LOCALE_ID, useValue: 'pt-BR' },
    // Ícones Lucide: traço fino, do tamanho da letra ao redor.
    provideNgIconsConfig({ size: '1.25em', strokeWidth: 2 }),
  ],
};

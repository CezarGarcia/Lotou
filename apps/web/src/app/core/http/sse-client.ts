import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { bearer } from '../auth/auth.interceptor';
import { AuthService } from '../auth/auth.service';
import { SseMessage, readSse } from './sse';

/**
 * Abre fluxos SSE da API com o token do comprador, como o interceptor faz com
 * o `HttpClient`. O token é lido a cada reconexão, então um token renovado
 * entra na conexão seguinte.
 */
@Injectable({ providedIn: 'root' })
export class SseClient {
  private readonly auth = inject(AuthService);

  connect(url: string): Observable<SseMessage> {
    return readSse(url, {
      headers: async () =>
        bearer(url, await firstValueFrom(this.auth.accessToken(), { defaultValue: '' })),
    });
  }
}

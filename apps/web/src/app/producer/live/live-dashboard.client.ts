import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, InjectionToken, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subscriber, firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import {
  ActivityEntry,
  CLOSE_FORBIDDEN,
  CLOSE_UNAUTHORIZED,
  ClientMessage,
  LiveMetrics,
  ServerMessage,
  parseServerMessage,
} from './live.protocol';

/** Caminho do WebSocket do painel, no mesmo domínio da loja. */
export const LIVE_PATH = '/api/v1/analytics/live';

/**
 * Situação da conexão, para o indicador da tela.
 *
 * - `idle`: nenhum show assinado, sem conexão.
 * - `connecting`: primeira conexão (abrindo e autenticando).
 * - `live`: autenticado; as assinaturas estão valendo.
 * - `reconnecting`: a conexão caiu e uma nova tentativa está marcada.
 * - `denied`: o servidor recusou o produtor; não adianta tentar de novo.
 */
export type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'denied';

/** Por que a conexão foi recusada de vez. */
export type LiveDenial = 'not-producer' | 'session-expired';

/** O que chega para um show assinado. */
export type LiveShowEvent =
  | { type: 'snapshot'; metrics: LiveMetrics; activity: ActivityEntry[] }
  | { type: 'metrics'; metrics: LiveMetrics }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'forbidden'; detail: string };

/** O pedaço do `WebSocket` que o cliente usa; os testes entregam um falso. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

const OPEN = 1;

export const WEB_SOCKET_FACTORY = new InjectionToken<(url: string) => WebSocketLike>(
  'WEB_SOCKET_FACTORY',
  { providedIn: 'root', factory: () => (url: string) => new WebSocket(url) },
);

export interface LiveClientOptions {
  /** Endereço do WebSocket; por padrão, `ws(s)://<loja>/api/v1/analytics/live`. */
  url?: string;
  /** Primeira espera antes de reconectar; dobra a cada falha seguida. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** Conexão autenticada por esse tempo zera a contagem de falhas. */
  stableAfterMs: number;
  /**
   * Com show assinado, o servidor manda métricas a cada segundo. Sem nenhuma
   * mensagem por esse tempo, a conexão é tida como morta (o navegador não
   * expõe o ping do protocolo) e o cliente reconecta.
   */
  staleAfterMs: number;
  /** Sem show assinado por esse tempo, a conexão é fechada. */
  idleCloseMs: number;
  /** Fonte do jitter; os testes fixam o valor. */
  random: () => number;
}

export const LIVE_CLIENT_OPTIONS = new InjectionToken<Partial<LiveClientOptions>>(
  'LIVE_CLIENT_OPTIONS',
);

const DEFAULTS: LiveClientOptions = {
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  stableAfterMs: 10_000,
  staleAfterMs: 15_000,
  idleCloseMs: 10_000,
  random: Math.random,
};

/**
 * Espera antes da tentativa `attempt` (0, 1, 2...): exponencial com teto e
 * "equal jitter", metade fixa e metade sorteada. Milhares de painéis que caem
 * juntos (um deploy do analytics) não voltam todos no mesmo instante.
 */
export function backoffDelay(
  attempt: number,
  options: Pick<LiveClientOptions, 'backoffBaseMs' | 'backoffMaxMs' | 'random'>,
): number {
  const ceiling = Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** attempt);
  return Math.round(ceiling / 2 + options.random() * (ceiling / 2));
}

/**
 * Cliente do WebSocket do painel ao vivo (`contracts/realtime-dashboard.md`).
 *
 * Uma conexão por aba, aberta quando a primeira tela assina um show e fechada
 * pouco depois que a última sai. O token vai na primeira mensagem (`auth`),
 * nunca na URL, e de novo a cada renovação. Se a conexão cai, o cliente
 * reconecta com espera exponencial e jitter e assina de novo os mesmos shows.
 *
 * Fechamentos do servidor: 4401 (token recusado, inclusive numa renovação com
 * o token de outro usuário) tenta uma vez renovar a sessão e reconectar; na
 * segunda recusa, a sessão expirou. 4403 (sem o papel de produtor) encerra sem
 * nova tentativa. Os demais, como 4408 (autenticação atrasada) e 1013 (cliente
 * lento ou falha temporária do servidor), reconectam com espera.
 *
 * A aba escondida não pausa nada: é um painel ao vivo. Sem rede, o cliente
 * espera o navegador voltar a ficar on-line em vez de tentar às cegas.
 */
@Injectable({ providedIn: 'root' })
export class LiveDashboardClient {
  private readonly auth = inject(AuthService);
  private readonly createSocket = inject(WEB_SOCKET_FACTORY);
  private readonly window = inject(DOCUMENT).defaultView;
  private readonly options: LiveClientOptions = {
    ...DEFAULTS,
    ...inject(LIVE_CLIENT_OPTIONS, { optional: true }),
  };

  private readonly statusState = signal<LiveStatus>('idle');
  private readonly denialState = signal<LiveDenial | null>(null);
  private readonly lastMessageState = signal<number | null>(null);
  private readonly retryAtState = signal<number | null>(null);

  /** Situação da conexão. */
  readonly status = this.statusState.asReadonly();
  /** Motivo da recusa quando `status` é `denied`. */
  readonly denial = this.denialState.asReadonly();
  /** Quando chegou a última mensagem do servidor (relógio do navegador, ms). */
  readonly lastMessageAt = this.lastMessageState.asReadonly();
  /** Quando será a próxima tentativa, durante a reconexão. */
  readonly retryAt = this.retryAtState.asReadonly();

  private readonly watchers = new Map<string, Set<Subscriber<LiveShowEvent>>>();
  private socket: WebSocketLike | null = null;
  private ready = false;
  /** O último token mandado nesta conexão. */
  private sentToken: string | null = null;
  /** Falhas seguidas: definem a espera da próxima tentativa. */
  private attempt = 0;
  /** Recusas 4401 seguidas, sem um `ready` no meio. */
  private authFailures = 0;

  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private waitingOnline = false;

  constructor() {
    // Token renovado com a conexão aberta: autentica de novo, sem reconectar.
    this.auth
      .tokenRenewed()
      .pipe(takeUntilDestroyed())
      .subscribe((token) => {
        if (
          this.socket?.readyState === OPEN &&
          this.sentToken !== null &&
          token !== this.sentToken
        ) {
          this.send({ type: 'auth', token });
          this.sentToken = token;
        }
      });

    const onOnline = () => this.handleOnline();
    this.window?.addEventListener('online', onOnline);
    inject(DestroyRef).onDestroy(() => {
      this.window?.removeEventListener('online', onOnline);
      this.shutdown();
    });
  }

  /**
   * Métricas e atividade de um show. Assinar abre a conexão (se preciso) e
   * manda `subscribe`; cancelar manda `unsubscribe`. Depois de uma reconexão,
   * chega uma foto nova (`snapshot`).
   */
  watch(showId: string): Observable<LiveShowEvent> {
    return new Observable<LiveShowEvent>((subscriber) => {
      clearTimeout(this.idleTimer);
      let set = this.watchers.get(showId);
      if (!set) {
        set = new Set();
        this.watchers.set(showId, set);
        if (this.ready) {
          this.send({ type: 'subscribe', showId });
          this.armStaleWatch();
        }
      }
      set.add(subscriber);
      if (!this.socket && this.reconnectTimer === undefined && !this.waitingOnline) {
        this.connect();
      }

      return () => {
        const current = this.watchers.get(showId);
        current?.delete(subscriber);
        if (current?.size === 0) {
          this.watchers.delete(showId);
          if (this.ready) {
            this.send({ type: 'unsubscribe', showId });
          }
        }
        if (this.watchers.size === 0) {
          this.whenIdle();
        }
      };
    });
  }

  /** Reconecta já, sem esperar a próxima tentativa marcada. */
  retryNow(): void {
    if (this.statusState() !== 'reconnecting' || this.socket) {
      return;
    }
    this.clearReconnect();
    this.connect('reconnecting');
  }

  /** Abre a conexão. `reconnecting` quando ela substitui uma que caiu. */
  private connect(status: 'connecting' | 'reconnecting' = 'connecting'): void {
    if (this.statusState() === 'denied' || this.watchers.size === 0) {
      return;
    }
    this.clearReconnect();
    this.statusState.set(status);

    let socket: WebSocketLike;
    try {
      socket = this.createSocket(this.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.ready = false;
    this.sentToken = null;

    socket.onopen = () => void this.authenticate(socket);
    socket.onmessage = (event) => {
      if (this.socket === socket) {
        this.receive(event.data);
      }
    };
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.closed(event.code);
      }
    };
    // Um erro sempre vem seguido do close, que é onde a reconexão é decidida.
    socket.onerror = () => undefined;
  }

  private async authenticate(socket: WebSocketLike): Promise<void> {
    const token = await firstValueFrom(this.auth.accessToken(), { defaultValue: '' });
    if (this.socket !== socket) {
      return;
    }
    if (!token) {
      this.drop();
      this.deny('session-expired');
      return;
    }
    this.sentToken = token;
    this.send({ type: 'auth', token });
  }

  private receive(data: unknown): void {
    this.lastMessageState.set(Date.now());
    this.armStaleWatch();
    const message = parseServerMessage(data);
    if (message) {
      this.dispatch(message);
    }
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'ready':
        this.authFailures = 0;
        // Depois de um `auth` de renovação, o servidor confirma com outro `ready`:
        // as assinaturas continuam valendo e não são repetidas.
        if (this.ready) {
          return;
        }
        this.ready = true;
        this.retryAtState.set(null);
        this.statusState.set('live');
        for (const showId of this.watchers.keys()) {
          this.send({ type: 'subscribe', showId });
        }
        clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => (this.attempt = 0), this.options.stableAfterMs);
        this.armStaleWatch();
        return;
      case 'snapshot':
        this.emit(message.showId, {
          type: 'snapshot',
          metrics: message.metrics,
          activity: message.activity,
        });
        return;
      case 'metrics':
        this.emit(message.showId, { type: 'metrics', metrics: message.metrics });
        return;
      case 'activity':
        this.emit(message.showId, { type: 'activity', entry: message.entry });
        return;
      case 'error':
        // `bad-request` é erro do próprio cliente: não há o que mostrar ao produtor.
        if (message.code === 'forbidden' && message.showId) {
          this.emit(message.showId, { type: 'forbidden', detail: message.detail });
        }
        return;
    }
  }

  private emit(showId: string, event: LiveShowEvent): void {
    for (const subscriber of this.watchers.get(showId) ?? []) {
      subscriber.next(event);
    }
  }

  private closed(code: number): void {
    this.socket = null;
    this.resetConnectionState();
    if (code === CLOSE_FORBIDDEN) {
      this.deny('not-producer');
      return;
    }
    if (code === CLOSE_UNAUTHORIZED) {
      void this.reauthenticate();
      return;
    }
    this.scheduleReconnect();
  }

  /** 4401: renova a sessão uma vez e reconecta; na segunda recusa seguida, desiste. */
  private async reauthenticate(): Promise<void> {
    this.authFailures++;
    if (this.authFailures > 1) {
      this.deny('session-expired');
      return;
    }
    this.statusState.set('reconnecting');
    const token = await firstValueFrom(this.auth.refreshSession(), { defaultValue: '' });
    if (!token) {
      this.deny('session-expired');
      return;
    }
    if (!this.socket && this.watchers.size > 0) {
      this.connect('reconnecting');
    } else if (this.watchers.size === 0) {
      this.statusState.set('idle');
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    if (this.watchers.size === 0) {
      this.statusState.set('idle');
      return;
    }
    this.statusState.set('reconnecting');
    if (this.window?.navigator.onLine === false) {
      this.waitingOnline = true;
      this.retryAtState.set(null);
      return;
    }
    const delay = backoffDelay(this.attempt, this.options);
    this.attempt++;
    this.retryAtState.set(Date.now() + delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect('reconnecting');
    }, delay);
  }

  /** A rede voltou: tenta logo, com um jitter curto para as abas não voltarem juntas. */
  private handleOnline(): void {
    if (!this.waitingOnline) {
      return;
    }
    this.waitingOnline = false;
    const delay = Math.round(this.options.random() * this.options.backoffBaseMs);
    this.retryAtState.set(Date.now() + delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect('reconnecting');
    }, delay);
  }

  private armStaleWatch(): void {
    clearTimeout(this.staleTimer);
    if (!this.ready || this.watchers.size === 0) {
      return;
    }
    this.staleTimer = setTimeout(() => {
      this.drop();
      this.scheduleReconnect();
    }, this.options.staleAfterMs);
  }

  private whenIdle(): void {
    clearTimeout(this.staleTimer);
    clearTimeout(this.idleTimer);
    if (!this.socket) {
      this.clearReconnect();
      if (this.statusState() !== 'denied') {
        this.statusState.set('idle');
      }
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (this.watchers.size === 0) {
        this.drop();
        this.attempt = 0;
        this.statusState.set('idle');
      }
    }, this.options.idleCloseMs);
  }

  private deny(reason: LiveDenial): void {
    this.clearReconnect();
    this.denialState.set(reason);
    this.statusState.set('denied');
  }

  /** Fecha a conexão atual sem passar pelo `onclose` (a decisão já foi tomada). */
  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    this.resetConnectionState();
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000);
      } catch {
        // Já fechado.
      }
    }
  }

  private resetConnectionState(): void {
    this.ready = false;
    this.sentToken = null;
    clearTimeout(this.staleTimer);
    clearTimeout(this.stableTimer);
  }

  private clearReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.waitingOnline = false;
    this.retryAtState.set(null);
  }

  private shutdown(): void {
    this.clearReconnect();
    clearTimeout(this.idleTimer);
    this.drop();
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private url(): string {
    if (this.options.url) {
      return this.options.url;
    }
    const location = this.window?.location;
    const scheme = location?.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location?.host ?? 'localhost'}${LIVE_PATH}`;
  }
}

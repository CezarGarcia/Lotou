import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  Observable,
  catchError,
  concat,
  filter,
  of,
  switchMap,
  takeWhile,
  timer,
} from 'rxjs';
import { ApiError, toApiError } from '../../core/http/problem';
import { SseError } from '../../core/http/sse';
import { QueueApi } from '../data/queue.api';
import { QueueState, QueueStatus } from '../data/sale.models';

/** Situações em que não há mais o que acompanhar. */
const SETTLED = new Set<QueueState>(['ADMITTED', 'NOT_REQUIRED', 'NOT_IN_QUEUE', 'CLOSED']);

/** Sem a hora de abertura da sala, tenta entrar de novo nesse intervalo. */
const NOT_OPEN_RETRY_MS = 30_000;

/** Espalha a entrada de quem esperava a sala abrir, para não chegarem todos no mesmo milissegundo. */
const OPENING_JITTER_MS = 3_000;

/**
 * O comprador na fila virtual: entra (POST, idempotente) e acompanha posição e
 * tempo estimado pelo SSE até a admissão. Antes da sala de espera abrir, espera
 * a abertura e entra sozinho.
 */
@Injectable()
export class QueueStore {
  private readonly api = inject(QueueApi);

  private readonly request = signal<{ showId: string; attempt: number } | null>(null);
  private readonly statusState = signal<QueueStatus | null>(null);
  private readonly errorState = signal<ApiError | null>(null);

  readonly status = this.statusState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly loading = computed(() => !this.status() && !this.error());
  /** A vez chegou (ou o show não exige fila): pode ir ao checkout. */
  readonly canBuy = computed(() => {
    const state = this.status()?.status;
    return state === 'ADMITTED' || state === 'NOT_REQUIRED';
  });

  /** Para os testes: o sorteio da espera na abertura da sala. */
  random = Math.random;

  constructor() {
    toObservable(this.request)
      .pipe(
        filter((request) => request !== null),
        switchMap(({ showId }) =>
          this.join(showId).pipe(
            catchError((error: unknown) => {
              this.errorState.set(error instanceof SseError ? error.apiError : toApiError(error));
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((status) => {
        this.errorState.set(null);
        this.statusState.set(status);
      });
  }

  start(showId: string): void {
    if (this.request()?.showId !== showId) {
      this.request.set({ showId, attempt: 0 });
    }
  }

  /** Entra de novo: depois de perder a vez, ou de um erro. */
  rejoin(): void {
    this.statusState.set(null);
    this.errorState.set(null);
    this.request.update((current) => current && { ...current, attempt: current.attempt + 1 });
  }

  private join(showId: string): Observable<QueueStatus> {
    return this.api.join(showId).pipe(switchMap((status) => this.follow(showId, status)));
  }

  private follow(showId: string, status: QueueStatus): Observable<QueueStatus> {
    switch (status.status) {
      case 'NOT_OPEN': {
        const opensAt = status.waitingRoomOpensAt ? Date.parse(status.waitingRoomOpensAt) : NaN;
        const wait = Number.isNaN(opensAt)
          ? NOT_OPEN_RETRY_MS
          : Math.max(0, opensAt - Date.now()) + this.random() * OPENING_JITTER_MS;
        return concat(of(status), timer(wait).pipe(switchMap(() => this.join(showId))));
      }
      case 'WAITING_ROOM':
      case 'QUEUED':
        return concat(
          of(status),
          this.api.events(showId).pipe(takeWhile((next) => !SETTLED.has(next.status), true)),
        );
      default:
        return of(status);
    }
  }
}

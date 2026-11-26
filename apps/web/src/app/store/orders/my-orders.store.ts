import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, forkJoin, map, of, startWith, switchMap } from 'rxjs';
import { ApiError, toApiError } from '../../core/http/problem';
import { PurchaseApi } from '../data/purchase.api';
import { OrderSummary } from '../data/sale.models';
import { Show } from '../data/show.models';
import { ShowsApi } from '../data/shows.api';

interface OrdersState {
  status: 'loading' | 'ready' | 'error';
  items: OrderSummary[];
  nextCursor: string | null;
  error?: ApiError;
}

const LOADING: OrdersState = { status: 'loading', items: [], nextCursor: null };

/**
 * "Meus ingressos": os pedidos do comprador, do mais novo ao mais antigo,
 * paginados por cursor. Os dados de cada show (artista, data, local) vêm do
 * catálogo, uma vez por show.
 */
@Injectable()
export class MyOrdersStore {
  private readonly purchase = inject(PurchaseApi);
  private readonly showsApi = inject(ShowsApi);

  private readonly attempt = signal(0);
  private readonly state = signal<OrdersState>(LOADING);
  private readonly loadingMoreState = signal(false);
  private readonly showsState = signal<ReadonlyMap<string, Show>>(new Map());

  readonly orders = computed(() => this.state().items);
  readonly loading = computed(() => this.state().status === 'loading');
  readonly error = computed(() => this.state().error);
  readonly empty = computed(() => this.state().status === 'ready' && this.orders().length === 0);
  readonly hasMore = computed(() => this.state().nextCursor !== null);
  readonly loadingMore = this.loadingMoreState.asReadonly();
  readonly shows = this.showsState.asReadonly();

  constructor() {
    toObservable(this.attempt)
      .pipe(
        switchMap(() =>
          this.purchase.orders().pipe(
            map((page): OrdersState => ({
              status: 'ready',
              items: page.items,
              nextCursor: page.nextCursor,
            })),
            catchError((error: unknown) =>
              of<OrdersState>({ ...LOADING, status: 'error', error: toApiError(error) }),
            ),
            startWith(LOADING),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((state) => {
        this.state.set(state);
        this.loadShows(state.items);
      });
  }

  retry(): void {
    this.attempt.update((value) => value + 1);
  }

  loadMore(): void {
    const { nextCursor } = this.state();
    if (!nextCursor || this.loadingMoreState()) {
      return;
    }
    this.loadingMoreState.set(true);
    this.purchase.orders(nextCursor).subscribe({
      next: (page) => {
        this.state.update((state) => ({
          ...state,
          items: [...state.items, ...page.items],
          nextCursor: page.nextCursor,
        }));
        this.loadingMoreState.set(false);
        this.loadShows(page.items);
      },
      error: (error: unknown) => {
        this.state.update((state) => ({ ...state, error: toApiError(error) }));
        this.loadingMoreState.set(false);
      },
    });
  }

  /** Busca os shows que ainda não estão em memória. Se um falhar, a linha mostra só o pedido. */
  private loadShows(orders: OrderSummary[]): void {
    const missing = [...new Set(orders.map((order) => order.showId))].filter(
      (id) => !this.showsState().has(id),
    );
    if (missing.length === 0) {
      return;
    }
    forkJoin(missing.map((id) => this.showsApi.get(id).pipe(catchError(() => of(null))))).subscribe(
      (shows) => {
        this.showsState.update((current) => {
          const next = new Map(current);
          for (const show of shows) {
            if (show) {
              next.set(show.id, show);
            }
          }
          return next;
        });
      },
    );
  }
}

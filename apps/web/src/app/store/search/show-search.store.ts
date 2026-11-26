import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, filter, map, of, startWith, switchMap } from 'rxjs';
import { ApiError, toApiError } from '../../core/http/problem';
import { EMPTY_FILTERS, ShowFilters, ShowSummary } from '../data/show.models';
import { ShowsApi } from '../data/shows.api';

interface SearchState {
  status: 'loading' | 'ready' | 'error';
  items: ShowSummary[];
  nextCursor: string | null;
  error?: ApiError;
}

const LOADING: SearchState = { status: 'loading', items: [], nextCursor: null };

/**
 * Estado da busca de shows. Os filtros são um fluxo: cada mudança cancela a
 * busca anterior (`switchMap`) e recomeça da primeira página, então uma
 * resposta atrasada nunca sobrescreve uma busca mais nova.
 */
@Injectable()
export class ShowSearchStore {
  private readonly api = inject(ShowsApi);

  /**
   * Filtros e número da tentativa: repetir uma busca que falhou refaz a
   * requisição. Começa vazio: nada é buscado até a página informar os filtros.
   */
  private readonly request = signal<{ filters: ShowFilters; attempt: number } | null>(null);
  private readonly state = signal<SearchState>(LOADING);
  private readonly loadingMoreState = signal(false);

  readonly filters = computed(() => this.request()?.filters ?? EMPTY_FILTERS);
  readonly shows = computed(() => this.state().items);
  readonly loading = computed(() => this.state().status === 'loading');
  readonly error = computed(() => this.state().error);
  readonly empty = computed(() => this.state().status === 'ready' && this.shows().length === 0);
  readonly hasMore = computed(() => this.state().nextCursor !== null);
  readonly loadingMore = this.loadingMoreState.asReadonly();

  constructor() {
    toObservable(this.request)
      .pipe(
        filter((request) => request !== null),
        switchMap(({ filters }) =>
          this.api.search(filters).pipe(
            map((page): SearchState => ({
              status: 'ready',
              items: page.items,
              nextCursor: page.nextCursor,
            })),
            catchError((error: unknown) =>
              of<SearchState>({ ...LOADING, status: 'error', error: toApiError(error) }),
            ),
            startWith(LOADING),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((state) => {
        this.loadingMoreState.set(false);
        this.state.set(state);
      });
  }

  search(filters: ShowFilters): void {
    this.request.update((current) => ({ filters, attempt: current?.attempt ?? 0 }));
  }

  retry(): void {
    this.request.update(
      (current) => current && { filters: current.filters, attempt: current.attempt + 1 },
    );
  }

  /** Busca a página seguinte e a acrescenta à lista. */
  loadMore(): void {
    const { nextCursor } = this.state();
    if (!nextCursor || this.loadingMoreState()) {
      return;
    }
    const request = this.request();
    if (!request) {
      return;
    }
    this.loadingMoreState.set(true);
    this.api.search(request.filters, nextCursor).subscribe({
      next: (page) => {
        // Se os filtros mudaram enquanto a página vinha, ela não vale mais.
        if (this.request() !== request) {
          return;
        }
        this.state.update((state) => ({
          ...state,
          items: [...state.items, ...page.items],
          nextCursor: page.nextCursor,
        }));
        this.loadingMoreState.set(false);
      },
      error: (error: unknown) => {
        if (this.request() !== request) {
          return;
        }
        this.state.update((state) => ({ ...state, error: toApiError(error) }));
        this.loadingMoreState.set(false);
      },
    });
  }
}

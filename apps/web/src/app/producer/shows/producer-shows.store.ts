import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { ApiError, toApiError } from '../../core/http/problem';
import { ProducerApi, ProducerShow } from '../data/producer.api';

interface ShowsState {
  status: 'loading' | 'ready' | 'error';
  items: ProducerShow[];
  nextCursor: string | null;
  error?: ApiError;
}

const LOADING: ShowsState = { status: 'loading', items: [], nextCursor: null };

/** Os shows do produtor, paginados por cursor, com "carregar mais". */
@Injectable()
export class ProducerShowsStore {
  private readonly api = inject(ProducerApi);

  private readonly attempt = signal(0);
  private readonly state = signal<ShowsState>(LOADING);
  private readonly loadingMoreState = signal(false);

  readonly shows = computed(() => this.state().items);
  readonly loading = computed(() => this.state().status === 'loading');
  readonly error = computed(() => this.state().error);
  readonly empty = computed(() => this.state().status === 'ready' && this.shows().length === 0);
  readonly hasMore = computed(() => this.state().nextCursor !== null);
  readonly loadingMore = this.loadingMoreState.asReadonly();

  constructor() {
    toObservable(this.attempt)
      .pipe(
        switchMap(() =>
          this.api.shows().pipe(
            map((page): ShowsState => ({
              status: 'ready',
              items: page.items,
              nextCursor: page.nextCursor,
            })),
            catchError((error: unknown) =>
              of<ShowsState>({ ...LOADING, status: 'error', error: toApiError(error) }),
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

  retry(): void {
    this.attempt.update((value) => value + 1);
  }

  loadMore(): void {
    const { nextCursor } = this.state();
    if (!nextCursor || this.loadingMoreState()) {
      return;
    }
    const attempt = this.attempt();
    this.loadingMoreState.set(true);
    this.api.shows(nextCursor).subscribe({
      next: (page) => {
        // Uma recarga começou enquanto a página vinha: ela não vale mais.
        if (this.attempt() !== attempt) {
          return;
        }
        this.state.update((state) => ({
          ...state,
          items: [...state.items, ...page.items],
          nextCursor: page.nextCursor,
          error: undefined,
        }));
        this.loadingMoreState.set(false);
      },
      error: (error: unknown) => {
        if (this.attempt() !== attempt) {
          return;
        }
        this.state.update((state) => ({ ...state, error: toApiError(error) }));
        this.loadingMoreState.set(false);
      },
    });
  }
}

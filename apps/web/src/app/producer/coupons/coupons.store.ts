import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Observable, catchError, filter, map, of, startWith, switchMap } from 'rxjs';
import { AttemptKey } from '../../core/http/idempotency';
import { ApiError, isTransient, toApiError } from '../../core/http/problem';
import { Coupon, CouponsApi, CreateCoupon } from '../data/coupons.api';

interface ListState {
  status: 'loading' | 'ready' | 'error';
  items: Coupon[];
  nextCursor: string | null;
  error?: ApiError;
}

const LOADING: ListState = { status: 'loading', items: [], nextCursor: null };

/** O resultado de uma criação, para o formulário reagir. */
export type CreateOutcome =
  { ok: true; coupon: Coupon } | { ok: false; field?: 'code'; message: string; traceId?: string };

/** A mensagem de um erro ao criar o cupom; `field` quando é de um campo. */
export function createErrorOutcome(error: ApiError): CreateOutcome {
  if (error.code === 'coupon-code-taken') {
    return { ok: false, field: 'code', message: 'Já existe um cupom com esse código neste show.' };
  }
  if (error.status === 403) {
    return { ok: false, message: 'Só o produtor dono do show pode criar cupons para ele.' };
  }
  return { ok: false, message: error.message, traceId: error.traceId };
}

/**
 * Os cupons de um show: a lista, a criação (com `Idempotency-Key` por
 * tentativa) e pausar ou retomar. A resposta do servidor substitui o cupom na
 * lista: usos, restantes e situação vêm sempre de lá.
 */
@Injectable()
export class CouponsStore {
  private readonly api = inject(CouponsApi);
  private readonly destroyRef = inject(DestroyRef);

  private readonly showId = signal<string | null>(null);
  private readonly attempt = signal(0);
  private readonly state = signal<ListState>(LOADING);
  private readonly createKey = new AttemptKey();

  readonly coupons = computed(() => this.state().items);
  readonly loading = computed(() => this.state().status === 'loading');
  readonly error = computed(() => this.state().error);
  readonly empty = computed(() => this.state().status === 'ready' && this.coupons().length === 0);
  readonly hasMore = computed(() => this.state().nextCursor !== null);

  readonly creating = signal(false);
  /** Cupons com pausar/retomar a caminho. */
  readonly busy = signal<ReadonlySet<string>>(new Set());
  /** Falha ao pausar ou retomar. */
  readonly actionError = signal<string | null>(null);

  constructor() {
    toObservable(computed(() => ({ showId: this.showId(), attempt: this.attempt() })))
      .pipe(
        filter(({ showId }) => showId !== null),
        switchMap(({ showId }) =>
          this.api.list(showId!).pipe(
            map((page): ListState => ({ status: 'ready', ...page })),
            catchError((error: unknown) =>
              of<ListState>({ ...LOADING, status: 'error', error: toApiError(error) }),
            ),
            startWith(LOADING),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((state) => this.state.set(state));
  }

  load(showId: string): void {
    if (this.showId() !== showId) {
      this.showId.set(showId);
    }
  }

  retry(): void {
    this.attempt.update((value) => value + 1);
  }

  loadMore(): void {
    const { nextCursor } = this.state();
    const showId = this.showId();
    if (!nextCursor || !showId) {
      return;
    }
    this.api
      .list(showId, nextCursor)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) =>
          this.state.update((state) => ({
            ...state,
            items: [...state.items, ...page.items],
            nextCursor: page.nextCursor,
          })),
        error: (error: unknown) =>
          this.state.update((state) => ({ ...state, error: toApiError(error) })),
      });
  }

  /** Cria o cupom. Repetir depois de uma falha de rede reaproveita a chave. */
  create(body: CreateCoupon): Observable<CreateOutcome> {
    this.creating.set(true);
    return this.api.create(body, this.createKey.for(body)).pipe(
      map((coupon): CreateOutcome => {
        this.createKey.reset();
        this.creating.set(false);
        this.state.update((state) => ({ ...state, items: [coupon, ...state.items] }));
        return { ok: true, coupon };
      }),
      catchError((raw: unknown) => {
        this.creating.set(false);
        const error = toApiError(raw);
        if (!isTransient(error)) {
          this.createKey.reset();
        }
        return of(createErrorOutcome(error));
      }),
      takeUntilDestroyed(this.destroyRef),
    );
  }

  pause(coupon: Coupon): void {
    this.toggle(coupon, this.api.pause(coupon.id));
  }

  resume(coupon: Coupon): void {
    this.toggle(coupon, this.api.resume(coupon.id));
  }

  private toggle(coupon: Coupon, request: Observable<Coupon>): void {
    if (this.busy().has(coupon.id)) {
      return;
    }
    this.actionError.set(null);
    this.busy.update((ids) => new Set(ids).add(coupon.id));
    const done = () =>
      this.busy.update((ids) => {
        const next = new Set(ids);
        next.delete(coupon.id);
        return next;
      });
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (updated) => {
        done();
        this.state.update((state) => ({
          ...state,
          items: state.items.map((item) => (item.id === updated.id ? updated : item)),
        }));
      },
      error: (raw: unknown) => {
        done();
        this.actionError.set(
          `Não foi possível mudar o cupom ${coupon.code}. ${toApiError(raw).message}`,
        );
        this.retry();
      },
    });
  }
}

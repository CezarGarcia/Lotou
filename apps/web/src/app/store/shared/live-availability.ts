import { DOCUMENT } from '@angular/common';
import { Signal, computed, inject } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import {
  Subject,
  catchError,
  exhaustMap,
  filter,
  interval,
  map,
  merge,
  of,
  scan,
  startWith,
  switchMap,
} from 'rxjs';
import { ApiError, toApiError } from '../../core/http/problem';
import { AvailabilityApi } from '../data/availability.api';
import { SaleState, SectorAvailability, ShowAvailability } from '../data/sale.models';

export const AVAILABILITY_POLL_MS = 5_000;

export interface AvailabilityState {
  value: ShowAvailability | null;
  /** Erro da última consulta. O valor anterior continua na tela. */
  error: ApiError | null;
  /** Já houve ao menos uma resposta (com valor ou erro). */
  loaded: boolean;
}

const INITIAL: AvailabilityState = { value: null, error: null, loaded: false };

export interface LiveAvailability {
  state: Signal<AvailabilityState>;
  /** O setor, pelo id, como está agora. */
  sector(id: string): SectorAvailability | undefined;
  /** Consulta de novo agora, sem esperar o próximo ciclo (depois de um "esgotado", por exemplo). */
  refresh(): void;
}

/**
 * Preço, lote e estoque de cada setor, consultados a cada 5 s enquanto a tela
 * está aberta. Com a aba em segundo plano, as consultas param. Uma falha não
 * apaga o que já estava na tela: a próxima volta tenta de novo.
 *
 * Precisa de contexto de injeção.
 */
export function injectLiveAvailability(
  showId: () => string | undefined,
  periodMs = AVAILABILITY_POLL_MS,
): LiveAvailability {
  const api = inject(AvailabilityApi);
  const document = inject(DOCUMENT);
  const refresh = new Subject<void>();

  const state = toSignal(
    toObservable(computed(showId)).pipe(
      filter((id): id is string => !!id),
      switchMap((id) =>
        merge(
          interval(periodMs).pipe(filter(() => document.visibilityState !== 'hidden')),
          refresh,
        ).pipe(
          startWith(null),
          exhaustMap(() =>
            api.show(id).pipe(
              map((value) => ({ value })),
              catchError((error: unknown) => of({ error: toApiError(error) })),
            ),
          ),
          scan(
            (current: AvailabilityState, result): AvailabilityState =>
              'value' in result
                ? { value: result.value, error: null, loaded: true }
                : { ...current, error: result.error, loaded: true },
            INITIAL,
          ),
          startWith(INITIAL),
        ),
      ),
    ),
    { initialValue: INITIAL },
  );

  const byId = computed(
    () => new Map((state().value?.sectors ?? []).map((sector) => [sector.id, sector])),
  );

  return { state, sector: (id) => byId().get(id), refresh: () => refresh.next() };
}

/** Rótulo de cada situação de venda, para os chips. */
export const SALE_LABELS: Record<SaleState, string> = {
  NOT_OPEN: 'Em breve',
  ON_SALE: 'À venda',
  PAUSED: 'Pausado',
  SOLD_OUT: 'Esgotado',
  CLOSED: 'Encerrado',
};

import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, exhaustMap, filter, map, of, switchMap, timer } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { isTransient, toApiError } from '../../core/http/problem';
import { CheckinApi, CheckinResponse, CheckinShow, CheckinSummary } from '../data/checkin.api';
import { ScanDebouncer } from './scan-debounce';
import { GateFeedback } from './gate-feedback';
import {
  ScanTone,
  ScanView,
  acceptedOnRetry,
  connectionFailure,
  describeCheckin,
} from './scan-result';

/** Quanto tempo o resultado fica na tela antes de a leitura seguinte começar. */
export const RESULT_MS: Record<ScanTone, number> = { ok: 2_500, warn: 5_000, error: 5_000 };

/** O contador de entradas é conferido nesse intervalo. */
export const SUMMARY_POLL_MS = 15_000;

/**
 * Até quanto tempo depois de uma tentativa sem resposta um "já utilizado" no
 * mesmo portão ainda é a mesma pessoa.
 */
export const RETRY_WINDOW_MS = 120_000;

/** Quantas leituras o histórico da tela guarda. */
export const HISTORY_SIZE = 5;

/** Uma leitura, como a tela mostra. */
export interface ScanRecord {
  id: number;
  /** Relógio do aparelho (UTC), para o histórico. */
  at: string;
  view: ScanView;
}

export type ScanSource = 'camera' | 'manual';

/**
 * O leitor da portaria de um show num portão: manda cada código ao
 * checkin-service e mostra o resultado em tela cheia por alguns segundos,
 * com vibração e bipe; depois, fica pronto para o próximo.
 *
 * - A câmera manda o mesmo código muitas vezes por segundo: repetições dentro
 *   de 5 s são ignoradas, e nada é lido enquanto há resultado na tela ou uma
 *   leitura a caminho.
 * - O código digitado (ou de um leitor USB, que "digita" e dá Enter) sempre
 *   segue, e substitui o resultado que estiver na tela.
 * - Quem decide é o servidor. A tela só traduz.
 */
@Injectable()
export class GateScannerStore {
  private readonly api = inject(CheckinApi);
  private readonly auth = inject(AuthService);
  private readonly feedback = inject(GateFeedback);
  private readonly destroyRef = inject(DestroyRef);

  private readonly context = signal<{ showId: string; gate: string } | null>(null);
  private readonly debouncer = new ScanDebouncer();
  /** Códigos cuja última tentativa ficou sem resposta, e quando ela começou. */
  private readonly unconfirmed = new Map<string, number>();
  private dismissTimer?: ReturnType<typeof setTimeout>;
  private sequence = 0;

  readonly shows = signal<CheckinShow[] | null>(null);
  readonly show = computed(
    () => this.shows()?.find((show) => show.showId === this.context()?.showId) ?? null,
  );
  readonly gate = computed(() => this.context()?.gate ?? '');

  /** O resultado em tela cheia; `null` quando o leitor está pronto. */
  readonly result = signal<ScanRecord | null>(null);
  readonly history = signal<ScanRecord[]>([]);
  /** Uma leitura está a caminho do servidor. */
  readonly checking = signal(false);
  readonly summary = signal<CheckinSummary | null>(null);
  /** Entradas por este portão. */
  readonly gateCount = computed(
    () => this.summary()?.byGate.find((item) => item.gate === this.gate())?.count ?? 0,
  );
  /** A câmera só lê com o leitor livre. */
  readonly busy = computed(() => this.checking() || this.result() !== null);

  constructor() {
    toObservable(this.context)
      .pipe(
        filter((context) => context !== null),
        map(({ showId }) => showId),
        switchMap((showId) =>
          timer(0, SUMMARY_POLL_MS).pipe(
            exhaustMap(() => this.api.summary(showId).pipe(catchError(() => EMPTY))),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((summary) => this.summary.set(summary));

    this.api
      .shows()
      .pipe(
        catchError(() => of([])),
        takeUntilDestroyed(),
      )
      .subscribe((shows) => this.shows.set(shows));

    this.destroyRef.onDestroy(() => clearTimeout(this.dismissTimer));
  }

  /** Começa a ler para um show num portão. */
  start(showId: string, gate: string): void {
    const current = this.context();
    if (current?.showId !== showId || current.gate !== gate) {
      this.context.set({ showId, gate });
    }
  }

  /**
   * Lê um código. Devolve `false` quando a leitura foi ignorada (repetição da
   * câmera, leitor ocupado ou código vazio).
   */
  submit(raw: string, source: ScanSource): boolean {
    const code = raw.trim();
    const context = this.context();
    if (!code || !context || this.checking()) {
      return false;
    }
    if (source === 'camera') {
      if (this.result() || !this.debouncer.accept(code)) {
        return false;
      }
    } else {
      this.debouncer.mark(code);
      this.dismiss();
    }
    this.feedback.unlock();
    this.checking.set(true);
    const startedAt = Date.now();
    this.api
      .checkIn(context.showId, context.gate, code)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.checking.set(false);
          const view = this.viewFor(code, response, context.gate);
          this.unconfirmed.delete(code);
          if (response.result === 'ACCEPTED') {
            this.countEntry(context.gate);
          }
          this.present(view);
        },
        error: (raw: unknown) => {
          this.checking.set(false);
          const error = toApiError(raw);
          if (error.status === 401) {
            this.auth.login();
            return;
          }
          if (isTransient(error)) {
            // Pode ter chegado ao servidor: a próxima tentativa do mesmo código sabe disso.
            this.unconfirmed.set(code, startedAt);
            this.present(connectionFailure(error.message));
            return;
          }
          this.present(
            error.status === 403
              ? {
                  tone: 'error',
                  icon: 'lucideLock',
                  title: 'Sem acesso à portaria',
                  detail: 'Sua conta não pode registrar entradas neste show.',
                  place: '',
                }
              : connectionFailure(error.message),
          );
        },
      });
    return true;
  }

  /** Tira o resultado da tela: o leitor fica pronto para o próximo. */
  dismiss(): void {
    clearTimeout(this.dismissTimer);
    this.result.set(null);
  }

  private viewFor(code: string, response: CheckinResponse, gate: string): ScanView {
    const show = this.show();
    const triedAt = this.unconfirmed.get(code);
    const first = response.firstEntry;
    if (
      response.result === 'ALREADY_USED' &&
      triedAt !== undefined &&
      first?.gate === gate &&
      Math.abs(Date.parse(first.at) - triedAt) <= RETRY_WINDOW_MS
    ) {
      return acceptedOnRetry(response);
    }
    return describeCheckin(response, {
      timezone: show?.timezone,
      doorsOpenAt: show?.doorsOpenAt,
    });
  }

  /** O contador sobe na hora; a próxima consulta traz o número do servidor. */
  private countEntry(gate: string): void {
    this.summary.update((summary) => {
      const current = summary ?? { checkedIn: 0, byGate: [], rejected: 0 };
      const known = current.byGate.some((item) => item.gate === gate);
      return {
        ...current,
        checkedIn: current.checkedIn + 1,
        byGate: known
          ? current.byGate.map((item) =>
              item.gate === gate ? { ...item, count: item.count + 1 } : item,
            )
          : [...current.byGate, { gate, count: 1 }],
      };
    });
  }

  private present(view: ScanView): void {
    const record: ScanRecord = { id: ++this.sequence, at: new Date().toISOString(), view };
    this.result.set(record);
    this.history.update((history) => [record, ...history].slice(0, HISTORY_SIZE));
    this.feedback.signal(view.tone);
    clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => {
      if (this.result()?.id === record.id) {
        this.result.set(null);
      }
    }, RESULT_MS[view.tone]);
  }
}

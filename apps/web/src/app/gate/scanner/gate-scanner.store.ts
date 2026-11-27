import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  TimeoutError,
  catchError,
  distinctUntilChanged,
  exhaustMap,
  filter,
  map,
  of,
  switchMap,
  timeout,
  timer,
} from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { isTransient, toApiError } from '../../core/http/problem';
import { CheckinApi, CheckinResponse, CheckinShow, CheckinSummary } from '../data/checkin.api';
import { GateOfflineStore, noResponse } from '../offline/gate-offline.store';
import { ScanDebouncer } from './scan-debounce';
import { GateFeedback } from './gate-feedback';
import {
  ScanTone,
  ScanView,
  acceptedOnRetry,
  connectionFailure,
  describeCheckin,
  describeSyncNotice,
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

/** Sem resposta do servidor nesse tempo, a leitura é validada no aparelho. */
export const CHECKIN_TIMEOUT_MS = 4_000;

/** Uma leitura, como a tela mostra. */
export interface ScanRecord {
  id: number;
  /** Relógio do aparelho (UTC), para o histórico. */
  at: string;
  view: ScanView;
  /** Um aviso do envio das leituras sem internet, não uma leitura agora. */
  sync?: boolean;
}

/** O show, o portão e os setores que ele atende (vazio, todos). */
interface ScanContext {
  showId: string;
  gate: string;
  sectors: readonly string[];
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
 * - Quem decide é o servidor. A tela só traduz. Sem resposta dele em 4 s
 *   (rede, timeout, 502/503/504), o aparelho decide com o pacote offline do
 *   show (ADR 38), e a leitura aceita entra na fila de envio.
 */
@Injectable()
export class GateScannerStore {
  private readonly api = inject(CheckinApi);
  private readonly auth = inject(AuthService);
  private readonly feedback = inject(GateFeedback);
  private readonly destroyRef = inject(DestroyRef);
  readonly offline = inject(GateOfflineStore);

  private readonly context = signal<ScanContext | null>(null);
  private readonly debouncer = new ScanDebouncer();
  /** Códigos cuja última tentativa ficou sem resposta, e quando ela começou. */
  private readonly unconfirmed = new Map<string, number>();
  private dismissTimer?: ReturnType<typeof setTimeout>;
  private sequence = 0;

  readonly shows = signal<CheckinShow[] | null>(null);
  /** O show da lista da portaria ou, sem internet, o guardado com o pacote. */
  readonly show = computed(
    () =>
      this.shows()?.find((show) => show.showId === this.context()?.showId) ??
      this.offline.stored()?.show ??
      null,
  );
  /** O fuso do show: da lista ou do pacote. */
  readonly timezone = computed(() => this.show()?.timezone ?? this.offline.stored()?.pkg.timezone);
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
        distinctUntilChanged(),
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

    // O nome do show vai junto com o pacote, para o topo abrir sem internet.
    effect(() => {
      const show = this.shows()?.find((item) => item.showId === this.context()?.showId);
      if (show) {
        this.offline.remember(show);
      }
    });

    this.offline.notices.pipe(takeUntilDestroyed()).subscribe((notice) =>
      this.record({
        view: describeSyncNotice(notice, { timezone: this.timezone() }),
        sync: true,
      }),
    );

    this.destroyRef.onDestroy(() => clearTimeout(this.dismissTimer));
  }

  /** Começa a ler para um show num portão, que pode atender só alguns setores. */
  start(showId: string, gate: string, sectors: readonly string[] = []): void {
    const current = this.context();
    if (
      current?.showId !== showId ||
      current.gate !== gate ||
      current.sectors.join() !== sectors.join()
    ) {
      this.context.set({ showId, gate, sectors });
    }
    this.offline.open(showId);
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
    // Sem internet (ou com o servidor fora há pouco), nem tenta: decide aqui. O
    // ingresso aceito aqui e ainda não enviado também: o servidor não sabe dele.
    if (!this.offline.shouldAskServer(startedAt) || this.offline.isUnsent(code)) {
      void this.decideHere(code, context);
      return true;
    }
    this.api
      .checkIn(context.showId, context.gate, code)
      .pipe(timeout({ first: CHECKIN_TIMEOUT_MS }), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.checking.set(false);
          this.offline.serverReachable();
          const view = this.viewFor(code, response, context.gate);
          this.unconfirmed.delete(code);
          if (response.result === 'ACCEPTED') {
            this.countEntry(context.gate);
          }
          this.learn(response, context.gate, startedAt);
          this.present(view);
        },
        error: (raw: unknown) => {
          const error =
            raw instanceof TimeoutError
              ? { status: 0, message: 'O servidor não respondeu a tempo.' }
              : toApiError(raw);
          if (noResponse(error.status)) {
            // Pode ter chegado ao servidor: a próxima tentativa com internet sabe disso.
            this.unconfirmed.set(code, startedAt);
            this.offline.serverUnreachable();
            void this.decideHere(code, context, error.message);
            return;
          }
          this.checking.set(false);
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

  /**
   * Valida no aparelho, com o pacote do show. Sem pacote guardado, não há o
   * que conferir: a tela pede para ler de novo, como antes.
   */
  private async decideHere(
    code: string,
    context: ScanContext,
    failure = 'Sem conexão com o servidor.',
  ): Promise<void> {
    const decision = await this.offline.check(code, context.gate, context.sectors);
    this.checking.set(false);
    if (!decision) {
      this.present(connectionFailure(`${failure} Este aparelho não tem a lista do show.`));
      return;
    }
    const { response, doorsOpenAt, timezone } = decision;
    if (response.result === 'ACCEPTED') {
      this.countEntry(context.gate);
    }
    const view = describeCheckin(response, { timezone, doorsOpenAt });
    this.present({ ...view, offline: !this.offline.online() });
  }

  /** O que o servidor disse do ingresso vai para a lista do aparelho. */
  private learn(response: CheckinResponse, gate: string, at: number): void {
    const ticketId = response.ticket?.ticketId;
    if (!ticketId) {
      return;
    }
    if (response.result === 'ACCEPTED') {
      this.offline.confirmed(ticketId, new Date(at).toISOString(), gate);
    } else if (response.result === 'ALREADY_USED' && response.firstEntry) {
      this.offline.confirmed(ticketId, response.firstEntry.at, response.firstEntry.gate);
    }
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
      timezone: this.timezone(),
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
    const record = this.record({ view });
    this.result.set(record);
    this.feedback.signal(view.tone);
    clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => {
      if (this.result()?.id === record.id) {
        this.result.set(null);
      }
    }, RESULT_MS[view.tone]);
  }

  private record(value: Omit<ScanRecord, 'id' | 'at'>): ScanRecord {
    const record: ScanRecord = { id: ++this.sequence, at: new Date().toISOString(), ...value };
    this.history.update((history) => [record, ...history].slice(0, HISTORY_SIZE));
    return record;
  }
}

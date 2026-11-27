import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { Observable, catchError, filter, map, of, startWith, switchMap, tap } from 'rxjs';
import { ApiError, toApiError } from '../../core/http/problem';
import { FinanceApi, RefundFailedOrder, Statement } from '../data/finance.api';

type Load<T> =
  { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; error: ApiError };

const LOADING = { status: 'loading' } as const;

/** Uma linha do relatório, com o sinal e a explicação de onde vem o número. */
export interface StatementLine {
  key: keyof Statement;
  label: string;
  /** `-` para o que é descontado do bruto. */
  sign: '' | '-';
  cents: number;
  explanation: string;
}

/**
 * As linhas do relatório, na ordem da fórmula: bruto − descontos − reembolsos
 * − taxa absorvida = valor a receber.
 */
export function statementLines(statement: Statement): StatementLine[] {
  const refunded =
    statement.refundedOrders === 1 ? '1 pedido' : `${statement.refundedOrders} pedidos`;
  return [
    {
      key: 'grossSalesCents',
      label: 'Vendas brutas',
      sign: '',
      cents: statement.grossSalesCents,
      explanation:
        'Os ingressos dos pedidos confirmados, ao preço do lote na hora da reserva, antes dos descontos.',
    },
    {
      key: 'discountsCents',
      label: 'Descontos de cupom',
      sign: '-',
      cents: statement.discountsCents,
      explanation: 'O que os cupons abateram dos ingressos. A taxa de serviço nunca tem desconto.',
    },
    {
      key: 'refundsCents',
      label: 'Reembolsos',
      sign: '-',
      cents: statement.refundsCents,
      explanation: `${refunded} reembolsado${statement.refundedOrders === 1 ? '' : 's'}: o valor dos ingressos, já com o desconto do cupom.`,
    },
    {
      key: 'platformFeeCents',
      label: 'Taxa de serviço absorvida',
      sign: '-',
      cents: statement.platformFeeCents,
      explanation:
        '10% de cada ingresso, quando o show não repassa a taxa ao comprador. Repassada, ela não sai do seu valor.',
    },
  ];
}

/**
 * O financeiro de um show: o relatório do analytics, o pedido do PDF por
 * e-mail e os pedidos com reembolso travado, que o produtor manda de novo.
 */
@Injectable()
export class FinanceStore {
  private readonly api = inject(FinanceApi);
  private readonly destroyRef = inject(DestroyRef);

  private readonly showId = signal<string | null>(null);
  private readonly statementAttempt = signal(0);
  private readonly refundsAttempt = signal(0);

  readonly statement = signal<Load<Statement>>(LOADING);
  readonly refundFailed = signal<Load<RefundFailedOrder[]>>(LOADING);
  readonly requestingPdf = signal(false);
  /** Pedidos com o reembolso sendo mandado de novo. */
  readonly retrying = signal<ReadonlySet<string>>(new Set());
  readonly retryError = signal<string | null>(null);

  readonly lines = computed(() => {
    const state = this.statement();
    return state.status === 'ready' ? statementLines(state.value) : [];
  });

  constructor() {
    this.loadEach(this.statementAttempt, (id) => this.api.statement(id)).subscribe((state) =>
      this.statement.set(state),
    );
    this.loadEach(this.refundsAttempt, (id) =>
      this.api.refundFailed(id).pipe(map((page) => page.items)),
    ).subscribe((state) => this.refundFailed.set(state));
  }

  load(showId: string): void {
    if (this.showId() !== showId) {
      this.showId.set(showId);
    }
  }

  reloadStatement(): void {
    this.statementAttempt.update((value) => value + 1);
  }

  reloadRefunds(): void {
    this.refundsAttempt.update((value) => value + 1);
  }

  /** Pede o PDF por e-mail. Emite `null` no sucesso ou o erro. */
  requestPdf(): Observable<ApiError | null> {
    const id = this.showId();
    if (!id || this.requestingPdf()) {
      return of(null);
    }
    this.requestingPdf.set(true);
    return this.api.requestPdf(id).pipe(
      map(() => null),
      catchError((raw: unknown) => of(toApiError(raw))),
      tap(() => this.requestingPdf.set(false)),
      takeUntilDestroyed(this.destroyRef),
    );
  }

  /** Manda o reembolso de novo: o pedido volta a REFUNDING e sai da lista. */
  retryRefund(order: RefundFailedOrder): Observable<boolean> {
    if (this.retrying().has(order.id)) {
      return of(false);
    }
    this.retryError.set(null);
    this.retrying.update((ids) => new Set(ids).add(order.id));
    const done = () =>
      this.retrying.update((ids) => {
        const next = new Set(ids);
        next.delete(order.id);
        return next;
      });
    return this.api.retryRefund(order.id).pipe(
      map(() => {
        done();
        this.refundFailed.update((state) =>
          state.status === 'ready'
            ? { ...state, value: state.value.filter((item) => item.id !== order.id) }
            : state,
        );
        return true;
      }),
      catchError((raw: unknown) => {
        done();
        const error = toApiError(raw);
        this.retryError.set(
          error.status === 409
            ? 'Este pedido não está mais com o reembolso travado. A lista foi atualizada.'
            : `Não foi possível mandar o reembolso de novo. ${error.message}`,
        );
        this.reloadRefunds();
        return of(false);
      }),
      takeUntilDestroyed(this.destroyRef),
    );
  }

  /** Busca a cada show ou tentativa, descartando respostas atrasadas. */
  private loadEach<T>(attempt: () => number, request: (showId: string) => Observable<T>) {
    return toObservable(computed(() => ({ showId: this.showId(), attempt: attempt() }))).pipe(
      filter(({ showId }) => showId !== null),
      switchMap(({ showId }) =>
        request(showId!).pipe(
          map((value): Load<T> => ({ status: 'ready', value })),
          catchError((raw: unknown) => of<Load<T>>({ status: 'error', error: toApiError(raw) })),
          startWith<Load<T>>(LOADING),
        ),
      ),
      takeUntilDestroyed(this.destroyRef),
    );
  }
}

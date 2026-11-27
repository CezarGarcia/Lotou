import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  Observable,
  catchError,
  concat,
  filter,
  of,
  switchMap,
  throwError,
  timer,
} from 'rxjs';
import { ApiError, isTransient, toApiError } from '../../core/http/problem';
import { PurchaseApi } from '../data/purchase.api';
import { CancelReason, Order, OrderStatus } from '../data/sale.models';

/** Enquanto o pagamento é processado, o pedido é consultado nesse intervalo. */
export const ORDER_POLL_MS = 2_000;

/**
 * Enquanto o reembolso anda, o pedido é consultado com menos pressa: o estorno
 * pode levar mais tempo (a saga tenta de novo com espera crescente).
 */
export const REFUND_POLL_MS = 5_000;

/** Estados que ainda vão mudar sozinhos, e de quanto em quanto tempo conferir. */
const POLL_EVERY: Partial<Record<OrderStatus, number>> = {
  PENDING: ORDER_POLL_MS,
  REFUNDING: REFUND_POLL_MS,
};

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING: 'Processando',
  CONFIRMED: 'Confirmado',
  CANCELLED: 'Cancelado',
  REFUNDING: 'Reembolso em andamento',
  REFUNDED: 'Reembolsado',
  REFUND_FAILED: 'Reembolso com problema',
};

export const CANCEL_REASONS: Record<CancelReason, string> = {
  PAYMENT_DECLINED: 'O pagamento foi recusado. Nada foi cobrado, e os ingressos voltaram à venda.',
  RESERVATION_EXPIRED:
    'A reserva expirou antes da confirmação do pagamento. Nada foi cobrado, e os ingressos voltaram à venda.',
  TICKET_CONFLICT:
    'Uma das cadeiras foi vendida para outra pessoa no mesmo instante. O pedido foi cancelado e nada foi cobrado.',
};

/** Por que o comprador não pode cancelar (`cancellation.reason` ou o `reason` do 409). */
export const CANCELLATION_BLOCKS: Record<string, string> = {
  WINDOW_EXPIRED: 'O prazo para cancelar acabou: o cancelamento vale até 7 dias depois da compra.',
  TOO_CLOSE_TO_SHOW:
    'Faltam menos de 48 horas para o show, e o pedido não pode mais ser cancelado.',
  TICKET_USED:
    'Um dos ingressos já foi usado na entrada do show, então o pedido não pode ser cancelado.',
  NOT_CONFIRMED: 'Só um pedido confirmado pode ser cancelado.',
};

/** A explicação de um bloqueio; motivo novo para a loja vira uma frase neutra. */
export function cancellationBlockMessage(reason: unknown): string {
  return (
    (typeof reason === 'string' ? CANCELLATION_BLOCKS[reason] : undefined) ??
    'Este pedido não pode ser cancelado.'
  );
}

/**
 * Um pedido. Enquanto ele está PENDING (o pagamento simulado é assíncrono) ou
 * REFUNDING (o estorno), é consultado até sair desse estado. Uma falha
 * passageira não para a consulta; um 404 ou 403, sim.
 *
 * O cancelamento é do pedido inteiro, pedido pelo comprador dentro da
 * política; quem decide se pode é o servidor (`cancellation.allowed`).
 */
@Injectable()
export class OrderStore {
  private readonly api = inject(PurchaseApi);
  private readonly destroyRef = inject(DestroyRef);

  /** Pedido, número da tentativa e se a primeira consulta espera (depois de cancelar). */
  private readonly request = signal<{ id: string; attempt: number; delayed: boolean } | null>(null);
  private readonly orderState = signal<Order | null>(null);
  private readonly errorState = signal<ApiError | null>(null);

  readonly order = this.orderState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly pending = computed(() => this.order()?.status === 'PENDING');

  /** O pedido de cancelamento está a caminho. */
  readonly cancelling = signal(false);
  /** Por que o cancelamento não foi aceito. */
  readonly cancelError = signal<{ message: string; traceId?: string } | null>(null);

  constructor() {
    toObservable(this.request)
      .pipe(
        filter((request) => request !== null),
        switchMap(({ id, delayed }) => {
          const first = delayed ? POLL_EVERY[this.orderState()?.status ?? 'PENDING'] : 0;
          return this.poll(id, first ?? 0).pipe(
            catchError((error: ApiError) => {
              this.errorState.set(error);
              return EMPTY;
            }),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((order) => {
        this.errorState.set(null);
        this.orderState.set(order);
      });
  }

  /**
   * Consulta o pedido depois de `delayMs` e de novo enquanto o estado for de
   * espera, no intervalo do estado. Uma falha passageira, com o pedido já na
   * tela, só pula a volta.
   */
  private poll(id: string, delayMs: number): Observable<Order> {
    const wait = delayMs === 0 ? of(0) : timer(delayMs);
    return wait.pipe(
      switchMap(() =>
        this.api.order(id).pipe(
          catchError((raw: unknown) => {
            const error = toApiError(raw);
            return isTransient(error) && this.orderState() ? of(null) : throwError(() => error);
          }),
        ),
      ),
      switchMap((order) => {
        const status = (order ?? this.orderState())?.status;
        const next = status ? POLL_EVERY[status] : undefined;
        const current = order ? of(order) : EMPTY;
        return next ? concat(current, this.poll(id, next)) : current;
      }),
    );
  }

  load(id: string): void {
    if (this.request()?.id !== id) {
      this.orderState.set(null);
      this.errorState.set(null);
      this.cancelError.set(null);
      this.request.set({ id, attempt: 0, delayed: false });
    }
  }

  retry(): void {
    this.errorState.set(null);
    this.request.update(
      (current) => current && { ...current, attempt: current.attempt + 1, delayed: false },
    );
  }

  /**
   * Pede o cancelamento. O servidor responde `202` com o pedido em REFUNDING, e
   * a tela passa a acompanhar o reembolso. Repetir é seguro do lado do servidor.
   */
  cancel(): void {
    const order = this.orderState();
    if (!order || this.cancelling()) {
      return;
    }
    this.cancelling.set(true);
    this.cancelError.set(null);
    this.api
      .cancelOrder(order.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.cancelling.set(false);
          // Uma resposta sem corpo ainda mostra o reembolso começando.
          this.orderState.set(updated?.id ? updated : { ...order, status: 'REFUNDING' });
          this.restartPolling();
        },
        error: (raw: unknown) => {
          this.cancelling.set(false);
          const error = toApiError(raw);
          this.cancelError.set({
            message:
              error.code === 'cancellation-not-allowed'
                ? cancellationBlockMessage(error.details?.['reason'])
                : error.message,
            traceId: error.traceId,
          });
          // A situação mudou do lado do servidor (um ingresso usado, o prazo): relê.
          if (error.code === 'cancellation-not-allowed') {
            this.request.update(
              (current) => current && { ...current, attempt: current.attempt + 1, delayed: false },
            );
          }
        },
      });
  }

  private restartPolling(): void {
    this.request.update(
      (current) => current && { ...current, attempt: current.attempt + 1, delayed: true },
    );
  }
}

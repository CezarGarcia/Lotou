import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  catchError,
  exhaustMap,
  filter,
  interval,
  startWith,
  switchMap,
  takeWhile,
  throwError,
} from 'rxjs';
import { ApiError, isTransient, toApiError } from '../../core/http/problem';
import { PurchaseApi } from '../data/purchase.api';
import { CancelReason, Order, OrderStatus } from '../data/sale.models';

/** Enquanto o pagamento é processado, o pedido é consultado nesse intervalo. */
export const ORDER_POLL_MS = 2_000;

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

/**
 * Um pedido. Enquanto ele está PENDING (o pagamento simulado é assíncrono), é
 * consultado a cada 2 s até sair desse estado. Uma falha passageira não para
 * a consulta; um 404 ou 403, sim.
 */
@Injectable()
export class OrderStore {
  private readonly api = inject(PurchaseApi);

  /** Pedido e número da tentativa: repetir depois de um erro refaz a consulta. */
  private readonly request = signal<{ id: string; attempt: number } | null>(null);
  private readonly orderState = signal<Order | null>(null);
  private readonly errorState = signal<ApiError | null>(null);

  readonly order = this.orderState.asReadonly();
  readonly error = this.errorState.asReadonly();
  readonly pending = computed(() => this.order()?.status === 'PENDING');

  constructor() {
    toObservable(this.request)
      .pipe(
        filter((request) => request !== null),
        switchMap(({ id }) =>
          interval(ORDER_POLL_MS).pipe(
            startWith(0),
            exhaustMap(() =>
              this.api.order(id).pipe(
                catchError((raw: unknown) => {
                  const error = toApiError(raw);
                  // Passageira: tenta na próxima volta, sem apagar o que já está na tela.
                  return isTransient(error) && this.orderState() ? EMPTY : throwError(() => error);
                }),
              ),
            ),
            takeWhile((order) => order.status === 'PENDING', true),
            catchError((error: ApiError) => {
              this.errorState.set(error);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((order) => {
        this.errorState.set(null);
        this.orderState.set(order);
      });
  }

  load(id: string): void {
    if (this.request()?.id !== id) {
      this.orderState.set(null);
      this.errorState.set(null);
      this.request.set({ id, attempt: 0 });
    }
  }

  retry(): void {
    this.errorState.set(null);
    this.request.update((current) => current && { ...current, attempt: current.attempt + 1 });
  }
}

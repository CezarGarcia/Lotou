import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { IDEMPOTENCY_KEY } from '../../core/http/idempotency';
import { Page } from './show.models';
import { CreateReservation, Order, OrderQuote, OrderSummary, Reservation } from './sale.models';

export const RESERVATIONS_URL = '/api/v1/reservations';
export const ORDERS_URL = '/api/v1/orders';

export const ORDERS_PAGE_SIZE = 10;

/** Corpo do pedido e do orçamento: o cupom só vai quando existe. */
export function orderBody(reservationId: string, couponCode?: string | null) {
  return couponCode ? { reservationId, couponCode } : { reservationId };
}

/** Reservas e pedidos do comprador. Os POST levam `Idempotency-Key`. */
@Injectable({ providedIn: 'root' })
export class PurchaseApi {
  private readonly http = inject(HttpClient);

  reserve(body: CreateReservation, idempotencyKey: string): Observable<Reservation> {
    return this.http.post<Reservation>(RESERVATIONS_URL, body, {
      headers: new HttpHeaders({ [IDEMPOTENCY_KEY]: idempotencyKey }),
    });
  }

  reservation(id: string): Observable<Reservation> {
    return this.http.get<Reservation>(`${RESERVATIONS_URL}/${id}`);
  }

  /** Quanto o pedido vai custar (ingressos, desconto do cupom e taxa), sem criar nada. */
  quote(reservationId: string, couponCode?: string | null): Observable<OrderQuote> {
    return this.http.post<OrderQuote>(`${ORDERS_URL}/quote`, orderBody(reservationId, couponCode));
  }

  /**
   * Fecha o pedido de uma reserva, com o cupom, se houver. O pagamento é
   * simulado e assíncrono: o pedido nasce PENDING.
   */
  placeOrder(
    reservationId: string,
    idempotencyKey: string,
    couponCode?: string | null,
  ): Observable<Order> {
    return this.http.post<Order>(ORDERS_URL, orderBody(reservationId, couponCode), {
      headers: new HttpHeaders({ [IDEMPOTENCY_KEY]: idempotencyKey }),
    });
  }

  /** Pede o cancelamento do pedido inteiro: `202` com o pedido em REFUNDING. Repetir é seguro. */
  cancelOrder(id: string): Observable<Order> {
    return this.http.post<Order>(`${ORDERS_URL}/${id}/cancel`, {});
  }

  order(id: string): Observable<Order> {
    return this.http.get<Order>(`${ORDERS_URL}/${id}`);
  }

  orders(cursor?: string): Observable<Page<OrderSummary>> {
    let params = new HttpParams().set('limit', ORDERS_PAGE_SIZE);
    if (cursor) {
      params = params.set('cursor', cursor);
    }
    return this.http.get<Page<OrderSummary>>(ORDERS_URL, { params });
  }
}

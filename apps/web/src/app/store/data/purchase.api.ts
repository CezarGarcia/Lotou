import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { IDEMPOTENCY_KEY } from '../../core/http/idempotency';
import { Page } from './show.models';
import { CreateReservation, Order, OrderSummary, Reservation } from './sale.models';

export const RESERVATIONS_URL = '/api/v1/reservations';
export const ORDERS_URL = '/api/v1/orders';

export const ORDERS_PAGE_SIZE = 10;

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

  /** Fecha o pedido de uma reserva. O pagamento é simulado e assíncrono: o pedido nasce PENDING. */
  placeOrder(reservationId: string, idempotencyKey: string): Observable<Order> {
    return this.http.post<Order>(
      ORDERS_URL,
      { reservationId },
      { headers: new HttpHeaders({ [IDEMPOTENCY_KEY]: idempotencyKey }) },
    );
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

import { HttpClient, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { IDEMPOTENCY_KEY } from '../../core/http/idempotency';
import { Page } from '../../store/data/show.models';

/** Cupons dos shows do produtor (order-service, via gateway). */
export const COUPONS_URL = '/api/v1/coupons';

export type CouponKind = 'PERCENT' | 'AMOUNT';
export type CouponStatus = 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'EXHAUSTED';

export interface Coupon {
  id: string;
  showId: string;
  code: string;
  kind: CouponKind;
  /** De 1 a 100, em `PERCENT`. */
  percent: number | null;
  /** Desconto por pedido, em centavos, em `AMOUNT`. */
  amountCents: number | null;
  maxUses: number;
  uses: number;
  remaining: number;
  status: CouponStatus | string;
  /** UTC. */
  validUntil: string;
  /** Vazio: vale para todos os setores. */
  sectorIds: string[];
  /** Quanto o cupom já deu de desconto, somando os pedidos. */
  discountGivenCents: number;
  createdAt: string;
}

export type CreateCoupon = {
  showId: string;
  code: string;
  maxUses: number;
  /** UTC. */
  validUntil: string;
  sectorIds?: string[];
} & ({ kind: 'PERCENT'; percent: number } | { kind: 'AMOUNT'; amountCents: number });

@Injectable({ providedIn: 'root' })
export class CouponsApi {
  private readonly http = inject(HttpClient);

  /** Os cupons de um show. Aceita a lista pura ou paginada por cursor. */
  list(showId: string, cursor?: string): Observable<Page<Coupon>> {
    let params = new HttpParams().set('showId', showId).set('limit', 50);
    if (cursor) {
      params = params.set('cursor', cursor);
    }
    return this.http
      .get<Coupon[] | Page<Coupon>>(COUPONS_URL, { params })
      .pipe(
        map((body) =>
          Array.isArray(body)
            ? { items: body, nextCursor: null }
            : { items: body.items ?? [], nextCursor: body.nextCursor ?? null },
        ),
      );
  }

  create(body: CreateCoupon, idempotencyKey: string): Observable<Coupon> {
    return this.http.post<Coupon>(COUPONS_URL, body, {
      headers: new HttpHeaders({ [IDEMPOTENCY_KEY]: idempotencyKey }),
    });
  }

  pause(id: string): Observable<Coupon> {
    return this.http.post<Coupon>(`${COUPONS_URL}/${id}/pause`, {});
  }

  resume(id: string): Observable<Coupon> {
    return this.http.post<Coupon>(`${COUPONS_URL}/${id}/resume`, {});
  }
}

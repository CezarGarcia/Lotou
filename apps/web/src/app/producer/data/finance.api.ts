import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { Page } from '../../store/data/show.models';

export const ANALYTICS_SHOWS_URL = '/api/v1/analytics/shows';
export const STATEMENT_REPORTS_URL = '/api/v1/reports/statements';
export const ORDERS_URL = '/api/v1/orders';

/**
 * Relatório financeiro de um show (analytics). Tudo em centavos:
 * `receivableCents` = bruto − descontos − reembolsos − taxa absorvida.
 */
export interface Statement {
  /** Subtotal dos pedidos confirmados (ingressos ao preço do lote, antes do desconto). */
  grossSalesCents: number;
  /** Descontos de cupom. */
  discountsCents: number;
  /** Subtotal − desconto dos pedidos reembolsados. */
  refundsCents: number;
  /** Taxa de serviço absorvida pelo produtor (shows com `serviceFeePaidBy = PRODUCER`). */
  platformFeeCents: number;
  /** Taxa paga pelos compradores: só informativa, não passa pelo produtor. */
  buyerFeesCents: number;
  receivableCents: number;
  refundedOrders: number;
  /** Parcial durante as vendas; final quando o show termina. */
  partial: boolean;
}

/** Um pedido cujo estorno falhou 5 vezes e precisa de tratamento manual. */
export interface RefundFailedOrder {
  id: string;
  showId: string;
  totalCents: number;
  /** Quantos ingressos o pedido tinha. */
  tickets: number | null;
  createdAt: string;
  confirmedAt: string | null;
}

type Raw = Record<string, unknown>;

const cents = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Lê o relatório; um campo ausente vale zero, e `partial` ausente conta como parcial. */
export function toStatement(raw: Raw): Statement {
  return {
    grossSalesCents: cents(raw['grossSalesCents']),
    discountsCents: cents(raw['discountsCents']),
    refundsCents: cents(raw['refundsCents']),
    platformFeeCents: cents(raw['platformFeeCents']),
    buyerFeesCents: cents(raw['buyerFeesCents']),
    receivableCents: cents(raw['receivableCents']),
    refundedOrders: cents(raw['refundedOrders']),
    partial: raw['partial'] !== false,
  };
}

/** Lê um pedido da lista de reembolsos com problema (a forma do pedido do order-service). */
export function toRefundFailedOrder(raw: Raw): RefundFailedOrder {
  const tickets = raw['tickets'];
  return {
    id: text(raw['id'] ?? raw['orderId']),
    showId: text(raw['showId']),
    totalCents: cents(raw['totalCents']),
    tickets: typeof tickets === 'number' ? tickets : Array.isArray(tickets) ? tickets.length : null,
    createdAt: text(raw['createdAt']),
    confirmedAt: text(raw['confirmedAt']) || null,
  };
}

@Injectable({ providedIn: 'root' })
export class FinanceApi {
  private readonly http = inject(HttpClient);

  statement(showId: string): Observable<Statement> {
    return this.http.get<Raw>(`${ANALYTICS_SHOWS_URL}/${showId}/statement`).pipe(map(toStatement));
  }

  /** Pede o PDF do relatório: `202`, e ele chega por e-mail. */
  requestPdf(showId: string): Observable<unknown> {
    return this.http.post(STATEMENT_REPORTS_URL, { showId });
  }

  refundFailed(showId: string, cursor?: string): Observable<Page<RefundFailedOrder>> {
    let params = new HttpParams().set('showId', showId);
    if (cursor) {
      params = params.set('cursor', cursor);
    }
    return this.http
      .get<Raw[] | { items?: Raw[]; nextCursor?: string | null }>(`${ORDERS_URL}/refund-failed`, {
        params,
      })
      .pipe(
        map((body) => {
          const items = Array.isArray(body) ? body : (body.items ?? []);
          return {
            items: items.map(toRefundFailedOrder).filter((order) => order.id !== ''),
            nextCursor: Array.isArray(body) ? null : (body.nextCursor ?? null),
          };
        }),
      );
  }

  /** Pedido em REFUND_FAILED volta a REFUNDING. */
  retryRefund(orderId: string): Observable<unknown> {
    return this.http.post(`${ORDERS_URL}/${orderId}/refund/retry`, {});
  }
}

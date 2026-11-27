import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, catchError, forkJoin, map, of, switchMap, tap } from 'rxjs';
import { PurchaseApi } from '../data/purchase.api';
import { Order, Ticket } from '../data/sale.models';
import { Show } from '../data/show.models';
import { ShowsApi } from '../data/shows.api';

/** Os ingressos de um pedido, com o show, como ficam guardados no aparelho. */
export interface SavedOrder {
  orderId: string;
  show: Show;
  tickets: Ticket[];
}

/** O que fica no localStorage: de quem são os ingressos e quando foram salvos. */
export interface SavedWallet {
  version: 1;
  userId: string;
  savedAt: string;
  orders: SavedOrder[];
}

import { WALLET_KEY } from './wallet-key';

export { WALLET_KEY };

/** Depois do início do show, o ingresso ainda fica 12 h (shows longos, festas). */
const KEEP_AFTER_START_MS = 12 * 60 * 60 * 1000;

/** Quantas páginas de "Meus ingressos" a sincronização olha (10 pedidos cada). */
const SYNC_PAGES = 3;

/** O ingresso ainda serve: válido e com o QR assinado. */
function usable(ticket: Ticket): boolean {
  return ticket.status === 'VALID' && !!ticket.code;
}

function upcoming(show: Show, now: number): boolean {
  return Date.parse(show.startsAt) + KEEP_AFTER_START_MS > now;
}

/**
 * Carteira de ingressos no aparelho (ADR 37). Com internet e login, a loja
 * guarda aqui os ingressos válidos dos próximos shows: o show, o setor, a
 * cadeira e o código do QR. A página "Ingressos salvos" lê daqui sem chamar a
 * API nem pedir login, e o QR é desenhado no próprio aparelho: o ingresso
 * abre na porta do show mesmo sem sinal.
 *
 * O código do QR é o ingresso, então ele só fica neste aparelho, no
 * localStorage do domínio da loja, e sai no logout. Ingressos de show que já
 * passou são descartados na leitura.
 */
@Injectable({ providedIn: 'root' })
export class TicketWallet {
  private readonly document = inject(DOCUMENT);
  private readonly purchases = inject(PurchaseApi);
  private readonly showsApi = inject(ShowsApi);

  private readonly state = signal<SavedWallet | null>(this.read());

  /** Os pedidos com ingresso para usar, do show mais próximo ao mais distante. */
  readonly orders = computed(() => {
    const now = Date.now();
    return (this.state()?.orders ?? [])
      .filter((order) => upcoming(order.show, now) && order.tickets.some(usable))
      .sort((a, b) => Date.parse(a.show.startsAt) - Date.parse(b.show.startsAt));
  });

  readonly ticketCount = computed(() =>
    this.orders().reduce((total, order) => total + order.tickets.filter(usable).length, 0),
  );

  /** Quando os ingressos foram atualizados pela última vez, com internet. */
  readonly savedAt = computed(() => this.state()?.savedAt ?? null);

  /**
   * Busca os pedidos confirmados do comprador e guarda os ingressos dos
   * próximos shows. Falhas de rede não apagam o que já estava salvo.
   */
  sync(userId: string): Observable<void> {
    if (!userId) {
      return of(undefined);
    }
    return this.confirmedOrderIds().pipe(
      switchMap((ids) =>
        ids.length === 0
          ? of([])
          : forkJoin(ids.map((id) => this.purchases.order(id).pipe(catchError(() => of(null))))),
      ),
      switchMap((orders) => this.withShows(orders.filter((o): o is Order => o !== null))),
      tap((saved) =>
        this.write({ version: 1, userId, savedAt: new Date().toISOString(), orders: saved }),
      ),
      map(() => undefined),
      catchError(() => of(undefined)),
    );
  }

  /**
   * Atualiza um pedido só (a página do pedido acabou de carregá-lo): guarda os
   * ingressos se ele estiver confirmado, ou tira da carteira se não estiver.
   */
  remember(userId: string, order: Order, show: Show): void {
    if (!userId) {
      return;
    }
    const current = this.state();
    const others =
      current?.userId === userId ? current.orders.filter((o) => o.orderId !== order.id) : [];
    const keep =
      order.status === 'CONFIRMED' && order.tickets.some(usable) && upcoming(show, Date.now());
    const orders = keep ? [...others, { orderId: order.id, show, tickets: order.tickets }] : others;
    this.write({
      version: 1,
      userId,
      savedAt: current?.savedAt ?? new Date().toISOString(),
      orders,
    });
  }

  /** Apaga os ingressos deste aparelho (logout ou outra pessoa entrou). */
  clear(): void {
    this.state.set(null);
    try {
      this.storage()?.removeItem(WALLET_KEY);
    } catch {
      // Sem acesso ao armazenamento: não havia nada salvo.
    }
  }

  /** Se a carteira é de outra pessoa, ela é apagada antes de guardar a nova. */
  forgetOthers(userId: string): void {
    const current = this.state();
    if (current && userId && current.userId !== userId) {
      this.clear();
    }
  }

  private confirmedOrderIds(): Observable<string[]> {
    const collect = (
      cursor: string | undefined,
      page: number,
      ids: string[],
    ): Observable<string[]> =>
      this.purchases.orders(cursor).pipe(
        switchMap((result) => {
          const all = [
            ...ids,
            ...result.items.filter((o) => o.status === 'CONFIRMED').map((o) => o.id),
          ];
          return result.nextCursor && page + 1 < SYNC_PAGES
            ? collect(result.nextCursor, page + 1, all)
            : of(all);
        }),
      );
    return collect(undefined, 0, []);
  }

  private withShows(orders: Order[]): Observable<SavedOrder[]> {
    const showIds = [...new Set(orders.map((order) => order.showId))];
    if (showIds.length === 0) {
      return of([]);
    }
    return forkJoin(
      showIds.map((id) => this.showsApi.get(id).pipe(catchError(() => of(null)))),
    ).pipe(
      map((shows) => {
        const byId = new Map(shows.filter((s): s is Show => s !== null).map((s) => [s.id, s]));
        const now = Date.now();
        return orders
          .map((order) => ({ order, show: byId.get(order.showId) }))
          .filter(
            (item): item is { order: Order; show: Show } =>
              !!item.show && upcoming(item.show, now) && item.order.tickets.some(usable),
          )
          .map(({ order, show }) => ({ orderId: order.id, show, tickets: order.tickets }));
      }),
    );
  }

  private read(): SavedWallet | null {
    try {
      const raw = this.storage()?.getItem(WALLET_KEY);
      const parsed = raw ? (JSON.parse(raw) as SavedWallet) : null;
      return parsed?.version === 1 && Array.isArray(parsed.orders) ? parsed : null;
    } catch {
      return null;
    }
  }

  private write(wallet: SavedWallet): void {
    this.state.set(wallet);
    try {
      this.storage()?.setItem(WALLET_KEY, JSON.stringify(wallet));
    } catch {
      // Armazenamento cheio ou bloqueado (aba anônima): a carteira vale só nesta visita.
    }
  }

  private storage(): Storage | undefined {
    try {
      return this.document.defaultView?.localStorage;
    } catch {
      return undefined;
    }
  }
}

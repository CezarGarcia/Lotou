import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { Page, ShowStatus } from '../../store/data/show.models';
import { SHOWS_URL } from '../../store/data/shows.api';

/** Shows do produtor no analytics (read models), via gateway. */
export const PRODUCER_SHOWS_URL = '/api/v1/analytics/shows';

export const PRODUCER_PAGE_SIZE = 20;

/** Um show na lista do painel, com o resumo das vendas. */
export interface ProducerShow {
  id: string;
  title: string;
  artist: string;
  /** UTC. */
  startsAt: string;
  /** Fuso IANA do local: as datas do show aparecem nele. */
  timezone: string | undefined;
  venueName: string;
  city: string;
  status: ShowStatus | string;
  ticketsSold: number;
  revenueCents: number;
}

type Raw = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Lê um show da resposta do analytics: `{showId, title, artist, startsAt,
 * timezone, venueName, city, status, ticketsSold, revenueCents}`. Aceita também
 * `id` e o local como objeto `venue`, a forma do catálogo.
 */
export function toProducerShow(raw: Raw): ProducerShow {
  const venue = (
    typeof raw['venue'] === 'object' && raw['venue'] !== null ? raw['venue'] : {}
  ) as Raw;
  return {
    id: text(raw['showId'] ?? raw['id']),
    title: text(raw['title']),
    artist: text(raw['artist']),
    startsAt: text(raw['startsAt']),
    timezone: text(raw['timezone'] ?? venue['timezone']) || undefined,
    venueName: text(raw['venueName'] ?? venue['name']),
    city: text(raw['city'] ?? venue['city']),
    status: text(raw['status']),
    ticketsSold: count(raw['ticketsSold']),
    revenueCents: count(raw['revenueCents']),
  };
}

@Injectable({ providedIn: 'root' })
export class ProducerApi {
  private readonly http = inject(HttpClient);

  /** Os shows do produtor do token, paginados por cursor. */
  shows(cursor?: string): Observable<Page<ProducerShow>> {
    let params = new HttpParams().set('limit', PRODUCER_PAGE_SIZE);
    if (cursor) {
      params = params.set('cursor', cursor);
    }
    return this.http.get<Page<Raw>>(PRODUCER_SHOWS_URL, { params }).pipe(
      map((page) => ({
        items: (page.items ?? []).map(toProducerShow),
        nextCursor: page.nextCursor ?? null,
      })),
    );
  }

  /**
   * Cancela o show (só o dono, em PUBLISHED ou ON_SALE). Todos os pedidos
   * confirmados entram em reembolso automático, com controle de vazão.
   */
  cancelShow(showId: string): Observable<unknown> {
    return this.http.post(`${SHOWS_URL}/${showId}/cancel`, {});
  }
}

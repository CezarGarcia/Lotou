import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';

/** Check-in na portaria (checkin-service, via gateway). */
export const CHECKINS_URL = '/api/v1/checkins';

/** Um show que a portaria pode atender: hoje e os próximos dias, da cópia local. */
export interface CheckinShow {
  showId: string;
  title: string;
  artist: string;
  /** UTC. */
  startsAt: string;
  /** Fuso IANA do local: os horários da portaria aparecem nele. */
  timezone: string | undefined;
  /** A partir de quando o check-in é aceito (UTC); `null` se o produtor não definiu. */
  doorsOpenAt: string | null;
  venueName: string;
}

/** O que a leitura de um ingresso deu. */
export type CheckinResult =
  | 'ACCEPTED'
  | 'ALREADY_USED'
  | 'INVALID_CODE'
  | 'UNKNOWN_TICKET'
  | 'CANCELLED'
  | 'WRONG_SHOW'
  | 'NOT_OPEN';

export interface CheckinTicket {
  ticketId: string;
  sectorName: string;
  seat: string | null;
}

/** Resposta do `POST /checkins`: sempre `200`, com o resultado. */
export interface CheckinResponse {
  result: CheckinResult | string;
  /** Quando o ingresso é conhecido. */
  ticket: CheckinTicket | null;
  /** Em `ALREADY_USED`: a primeira (e única) entrada. */
  firstEntry: { at: string; gate: string } | null;
}

export interface CheckinSummary {
  checkedIn: number;
  byGate: { gate: string; count: number }[];
  rejected: number;
}

type Raw = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Lê um show da lista da portaria; aceita `id` no lugar de `showId`. */
export function toCheckinShow(raw: Raw): CheckinShow {
  return {
    showId: text(raw['showId'] ?? raw['id']),
    title: text(raw['title']),
    artist: text(raw['artist']),
    startsAt: text(raw['startsAt']),
    timezone: text(raw['timezone']) || undefined,
    doorsOpenAt: text(raw['doorsOpenAt']) || null,
    venueName: text(raw['venueName']),
  };
}

/** Lê o resumo, tolerando campos ausentes (um contador começa em zero). */
export function toCheckinSummary(raw: Raw | null): CheckinSummary {
  const byGate = Array.isArray(raw?.['byGate']) ? (raw['byGate'] as Raw[]) : [];
  return {
    checkedIn: count(raw?.['checkedIn']),
    byGate: byGate
      .map((item) => ({ gate: text(item['gate']), count: count(item['count']) }))
      .filter((item) => item.gate !== ''),
    rejected: count(raw?.['rejected']),
  };
}

@Injectable({ providedIn: 'root' })
export class CheckinApi {
  private readonly http = inject(HttpClient);

  /** Shows de hoje e dos próximos dias. Aceita a lista pura ou paginada (`{items}`). */
  shows(): Observable<CheckinShow[]> {
    return this.http.get<Raw[] | { items?: Raw[] }>(`${CHECKINS_URL}/shows`).pipe(
      map((body) => (Array.isArray(body) ? body : (body?.items ?? []))),
      map((items) => items.map(toCheckinShow).filter((show) => show.showId !== '')),
    );
  }

  /** Lê um ingresso no portão. O servidor decide; a tela só mostra. */
  checkIn(showId: string, gate: string, code: string): Observable<CheckinResponse> {
    return this.http.post<CheckinResponse>(CHECKINS_URL, { showId, gate, code });
  }

  summary(showId: string): Observable<CheckinSummary> {
    return this.http
      .get<Raw>(`${CHECKINS_URL}/shows/${showId}/summary`)
      .pipe(map(toCheckinSummary));
  }
}

import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { GateSector, OfflinePackage, toOfflinePackage } from '../offline/offline-package';

/** Check-in na portaria (checkin-service, via gateway). */
export const CHECKINS_URL = '/api/v1/checkins';

/** Catálogo público de shows (event-service, via gateway). */
const SHOWS_URL = '/api/v1/shows';

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
  | 'NOT_OPEN'
  /** Só sem internet: o ingresso é de um setor que este portão não atende. */
  | 'WRONG_SECTOR';

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

/** Uma leitura feita sem internet, como vai no `POST /checkins/offline`. */
export interface OfflineScan {
  /** UUID v7 gerado no aparelho: reenviar a mesma leitura não grava de novo. */
  id: string;
  code: string;
  /** UTC, pelo relógio do aparelho. */
  scannedAt: string;
}

export interface OfflineBatch {
  showId: string;
  gate: string;
  deviceId: string;
  scans: OfflineScan[];
}

export type OfflineConflictKind = 'DUPLICATE' | 'CANCELLED' | 'UNKNOWN' | 'WRONG_SHOW';

/** O que o servidor fez com cada leitura enviada. */
export type OfflineScanResult =
  | { id: string; outcome: 'RECORDED' }
  | { id: string; outcome: 'DUPLICATE'; firstEntry: { gate: string; checkedInAt: string } | null }
  | { id: string; outcome: 'CONFLICT'; kind: OfflineConflictKind | string }
  | { id: string; outcome: 'REJECTED'; reason: string };

/** Até quantas leituras vão numa chamada. */
export const OFFLINE_BATCH_SIZE = 500;

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

/** Lê o resultado de uma leitura enviada; `null` se não dá para entender. */
export function toOfflineScanResult(raw: Raw): OfflineScanResult | null {
  const id = text(raw['id']);
  const first = raw['firstEntry'] as Raw | null | undefined;
  switch (raw['outcome']) {
    case 'RECORDED':
      return id ? { id, outcome: 'RECORDED' } : null;
    case 'DUPLICATE':
      return id
        ? {
            id,
            outcome: 'DUPLICATE',
            firstEntry:
              first && text(first['checkedInAt'])
                ? { gate: text(first['gate']), checkedInAt: text(first['checkedInAt']) }
                : null,
          }
        : null;
    case 'CONFLICT':
      return id ? { id, outcome: 'CONFLICT', kind: text(raw['kind']) } : null;
    case 'REJECTED':
      return id ? { id, outcome: 'REJECTED', reason: text(raw['reason']) } : null;
    default:
      return null;
  }
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

  /** O pacote para validar sem internet (ADR 38); `null` se a resposta não serve. */
  offlinePackage(showId: string): Observable<OfflinePackage | null> {
    return this.http
      .get<unknown>(`${CHECKINS_URL}/shows/${showId}/offline-package`)
      .pipe(map(toOfflinePackage));
  }

  /** Envia leituras feitas sem internet. Idempotente pelo id de cada leitura. */
  sendOffline(batch: OfflineBatch): Observable<OfflineScanResult[]> {
    return this.http.post<{ results?: Raw[] }>(`${CHECKINS_URL}/offline`, batch).pipe(
      map((body) => (Array.isArray(body?.results) ? body.results : [])),
      map((results) => results.map(toOfflineScanResult).filter((result) => result !== null)),
    );
  }

  /**
   * Os setores do show, pelo catálogo público (event-service), para a escolha
   * dos setores de um portão.
   */
  sectors(showId: string): Observable<GateSector[]> {
    return this.http.get<{ sectors?: Raw[] }>(`${SHOWS_URL}/${showId}`).pipe(
      map((show) => (Array.isArray(show?.sectors) ? show.sectors : [])),
      map((sectors) =>
        sectors
          .map((sector) => ({ id: text(sector['id']), name: text(sector['name']) }))
          .filter((sector) => sector.id !== ''),
      ),
    );
  }

  summary(showId: string): Observable<CheckinSummary> {
    return this.http
      .get<Raw>(`${CHECKINS_URL}/shows/${showId}/summary`)
      .pipe(map(toCheckinSummary));
  }
}

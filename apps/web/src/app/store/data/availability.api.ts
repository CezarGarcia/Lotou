import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { EMPTY, Observable, catchError, concat, exhaustMap, filter, map, timer } from 'rxjs';
import { SseClient } from '../../core/http/sse-client';
import { sseJson } from '../../core/http/sse';
import { SeatChange, SeatFeedEvent, SectorSeats, ShowAvailability } from './sale.models';

export const AVAILABILITY_URL = '/api/v1/availability';

/** Sem tempo real (o fluxo SSE recusou a conexão), o mapa se atualiza nesse intervalo. */
export const SEATS_FALLBACK_POLL_MS = 10_000;

@Injectable({ providedIn: 'root' })
export class AvailabilityApi {
  private readonly http = inject(HttpClient);
  private readonly sse = inject(SseClient);

  show(showId: string): Observable<ShowAvailability> {
    return this.http.get<ShowAvailability>(`${AVAILABILITY_URL}/${showId}`);
  }

  seats(showId: string, sectorId: string): Observable<SectorSeats> {
    return this.http.get<SectorSeats>(`${AVAILABILITY_URL}/${showId}/sectors/${sectorId}/seats`);
  }

  /**
   * O mapa de um setor ao vivo. Primeiro a foto do setor (GET), depois o fluxo
   * SSE: ele começa com outra foto, que já inclui o que mudou no meio tempo, e
   * segue com as mudanças. A cada reconexão chega uma foto nova, então nada se
   * perde enquanto a conexão esteve fora. Se o servidor recusar o fluxo, o mapa
   * passa a ser consultado a cada 10 s.
   */
  seatFeed(showId: string, sectorId: string): Observable<SeatFeedEvent> {
    const snapshot = () =>
      this.seats(showId, sectorId).pipe(
        map((sector): SeatFeedEvent => ({ type: 'snapshot', seats: sector.seats })),
      );
    const live = this.sse
      .connect(`${AVAILABILITY_URL}/${showId}/sectors/${sectorId}/seats/events`)
      .pipe(
        filter((message) => message.event === 'snapshot' || message.event === 'seats'),
        map((message): SeatFeedEvent =>
          message.event === 'snapshot'
            ? { type: 'snapshot', seats: sseJson<SectorSeats>(message).seats }
            : { type: 'change', change: sseJson<SeatChange>(message) },
        ),
        filter((event) => event.type === 'snapshot' || event.change.sectorId === sectorId),
        catchError(() =>
          timer(SEATS_FALLBACK_POLL_MS, SEATS_FALLBACK_POLL_MS).pipe(
            exhaustMap(() => snapshot().pipe(catchError(() => EMPTY))),
          ),
        ),
      );
    return concat(snapshot(), live);
  }
}

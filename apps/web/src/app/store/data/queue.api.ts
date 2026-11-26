import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, filter, map } from 'rxjs';
import { SseClient } from '../../core/http/sse-client';
import { sseJson } from '../../core/http/sse';
import { QueueStatus } from './sale.models';

export const QUEUE_URL = '/api/v1/queue';

/** Fila virtual dos shows de alta demanda. */
@Injectable({ providedIn: 'root' })
export class QueueApi {
  private readonly http = inject(HttpClient);
  private readonly sse = inject(SseClient);

  /** Entra na fila (ou na sala de espera). Repetir não muda a posição. */
  join(showId: string): Observable<QueueStatus> {
    return this.http.post<QueueStatus>(`${QUEUE_URL}/${showId}`, null);
  }

  status(showId: string): Observable<QueueStatus> {
    return this.http.get<QueueStatus>(`${QUEUE_URL}/${showId}`);
  }

  /** Posição e tempo estimado a cada segundo, até a admissão. */
  events(showId: string): Observable<QueueStatus> {
    return this.sse.connect(`${QUEUE_URL}/${showId}/events`).pipe(
      filter((message) => message.event === 'status'),
      map((message) => sseJson<QueueStatus>(message)),
    );
  }
}

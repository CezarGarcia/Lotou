import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { Page, Show, ShowFilters, ShowSummary } from './show.models';

/** Caminho da API de shows no gateway (mesmo domínio da loja). */
export const SHOWS_URL = '/api/v1/shows';

export const PAGE_SIZE = 12;

@Injectable({ providedIn: 'root' })
export class ShowsApi {
  private readonly http = inject(HttpClient);

  search(filters: ShowFilters, cursor?: string): Observable<Page<ShowSummary>> {
    let params = new HttpParams().set('limit', PAGE_SIZE);
    // Só os filtros preenchidos: a API recusa parâmetro vazio.
    for (const [name, value] of Object.entries(filters)) {
      if (value) {
        params = params.set(name, value);
      }
    }
    if (cursor) {
      params = params.set('cursor', cursor);
    }
    return this.http.get<Page<ShowSummary>>(SHOWS_URL, { params });
  }

  get(id: string): Observable<Show> {
    return this.http.get<Show>(`${SHOWS_URL}/${id}`);
  }
}

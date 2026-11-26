import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { EMPTY_FILTERS, Page, ShowSummary } from '../data/show.models';
import { ShowSearchStore } from './show-search.store';

const show = (id: string): ShowSummary => ({
  id,
  title: `Show ${id}`,
  artist: `Artista ${id}`,
  status: 'PUBLISHED',
  startsAt: '2027-03-20T23:00:00.000Z',
  salesStartAt: null,
  highDemand: false,
  venue: null,
  priceFromCents: 10_000,
});

const page = (ids: string[], nextCursor: string | null = null): Page<ShowSummary> => ({
  items: ids.map(show),
  nextCursor,
});

describe('ShowSearchStore', () => {
  let store: ShowSearchStore;
  let http: HttpTestingController;

  const ids = () => store.shows().map((item) => item.id);
  /** Aplica os efeitos pendentes: é quando a busca dispara a requisição. */
  const flush = () => TestBed.tick();

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ShowSearchStore],
    });
    store = TestBed.inject(ShowSearchStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('não busca nada antes de receber os filtros', () => {
    flush();
    http.expectNone(() => true);
  });

  it('envia só os filtros preenchidos e expõe o resultado', () => {
    store.search({ ...EMPTY_FILTERS, city: 'Recife' });
    flush();
    expect(store.loading()).toBe(true);

    const request = http.expectOne((req) => req.url === '/api/v1/shows');
    expect(request.request.params.keys().sort()).toEqual(['city', 'limit']);
    expect(request.request.params.get('city')).toBe('Recife');
    request.flush(page(['a', 'b']));

    expect(store.loading()).toBe(false);
    expect(ids()).toEqual(['a', 'b']);
    expect(store.hasMore()).toBe(false);
    expect(store.empty()).toBe(false);
  });

  it('marca a busca como vazia quando nada volta', () => {
    store.search(EMPTY_FILTERS);
    flush();
    http.expectOne(() => true).flush(page([]));

    expect(store.empty()).toBe(true);
  });

  it('acrescenta a página seguinte usando o cursor', () => {
    store.search(EMPTY_FILTERS);
    flush();
    http.expectOne(() => true).flush(page(['a', 'b'], 'cursor-1'));
    expect(store.hasMore()).toBe(true);

    store.loadMore();
    expect(store.loadingMore()).toBe(true);
    // Um segundo clique enquanto carrega não dispara outra requisição.
    store.loadMore();

    const next = http.expectOne((req) => req.params.get('cursor') === 'cursor-1');
    next.flush(page(['c']));

    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(store.hasMore()).toBe(false);
    expect(store.loadingMore()).toBe(false);
  });

  it('cancela a busca anterior quando os filtros mudam', () => {
    store.search({ ...EMPTY_FILTERS, artist: 'marina' });
    flush();
    const first = http.expectOne((req) => req.params.get('artist') === 'marina');

    store.search({ ...EMPTY_FILTERS, artist: 'nação' });
    flush();
    expect(first.cancelled).toBe(true);

    http.expectOne((req) => req.params.get('artist') === 'nação').flush(page(['n']));
    expect(ids()).toEqual(['n']);
  });

  it('descarta a página seguinte se os filtros mudaram enquanto ela vinha', () => {
    store.search(EMPTY_FILTERS);
    flush();
    http.expectOne(() => true).flush(page(['a'], 'cursor-1'));

    store.loadMore();
    const stale = http.expectOne((req) => req.params.has('cursor'));
    store.search({ ...EMPTY_FILTERS, city: 'Belém' });
    flush();
    http.expectOne((req) => req.params.get('city') === 'Belém').flush(page(['b']));
    stale.flush(page(['z']));

    expect(ids()).toEqual(['b']);
  });

  it('expõe o erro em Problem Details e refaz a busca no retry', () => {
    store.search(EMPTY_FILTERS);
    flush();
    http.expectOne(() => true).flush(
      { type: 'about:blank', title: 'Service Unavailable', status: 503, traceId: 't1' },
      { status: 503, statusText: 'Service Unavailable' },
    );

    expect(store.error()).toEqual({
      status: 503,
      message: 'Service Unavailable',
      traceId: 't1',
    });
    expect(ids()).toEqual([]);

    store.retry();
    flush();
    http.expectOne(() => true).flush(page(['a']));
    expect(store.error()).toBeUndefined();
    expect(ids()).toEqual(['a']);
  });
});

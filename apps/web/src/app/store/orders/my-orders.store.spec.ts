import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { OrderSummary } from '../data/sale.models';
import { Page } from '../data/show.models';
import { MyOrdersStore } from './my-orders.store';

const order = (id: string, showId = 's1'): OrderSummary => ({
  id,
  status: 'CONFIRMED',
  showId,
  totalCents: 10_000,
  tickets: [],
  createdAt: '2031-01-01T00:00:00Z',
});

const page = (items: OrderSummary[], nextCursor: string | null = null): Page<OrderSummary> => ({
  items,
  nextCursor,
});

describe('MyOrdersStore', () => {
  let store: MyOrdersStore;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), MyOrdersStore],
    });
    store = TestBed.inject(MyOrdersStore);
    http = TestBed.inject(HttpTestingController);
    TestBed.tick();
  });

  afterEach(() => http.verify());

  const ids = () => store.orders().map((item) => item.id);

  it('lista os pedidos e busca cada show uma vez só', () => {
    const request = http.expectOne((req) => req.url === '/api/v1/orders');
    expect(request.request.params.get('limit')).toBe('10');
    request.flush(page([order('o1', 's1'), order('o2', 's1'), order('o3', 's2')]));

    expect(ids()).toEqual(['o1', 'o2', 'o3']);
    http.expectOne('/api/v1/shows/s1').flush({ id: 's1', artist: 'Banda' });
    http.expectOne('/api/v1/shows/s2').flush(null, { status: 404, statusText: 'Not Found' });
    expect(store.shows().get('s1')?.artist).toBe('Banda');
    expect(store.shows().has('s2')).toBe(false);
  });

  it('carrega a página seguinte pelo cursor sem buscar de novo os shows conhecidos', () => {
    http.expectOne((req) => req.url === '/api/v1/orders').flush(page([order('o1')], 'c1'));
    http.expectOne('/api/v1/shows/s1').flush({ id: 's1', artist: 'Banda' });
    expect(store.hasMore()).toBe(true);

    store.loadMore();
    store.loadMore();
    http.expectOne((req) => req.params.get('cursor') === 'c1').flush(page([order('o2', 's1')]));

    expect(ids()).toEqual(['o1', 'o2']);
    expect(store.hasMore()).toBe(false);
    http.expectNone('/api/v1/shows/s1');
  });

  it('mostra a lista vazia e o erro com retry', () => {
    http
      .expectOne((req) => req.url === '/api/v1/orders')
      .flush(null, {
        status: 503,
        statusText: 'Service Unavailable',
      });
    expect(store.error()?.status).toBe(503);

    store.retry();
    TestBed.tick();
    http.expectOne((req) => req.url === '/api/v1/orders').flush(page([]));
    expect(store.error()).toBeUndefined();
    expect(store.empty()).toBe(true);
  });
});

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Order } from '../data/sale.models';
import { ORDER_POLL_MS, OrderStore, REFUND_POLL_MS } from './order.store';

const order = (value: Partial<Order> = {}): Order => ({
  id: 'o1',
  status: 'PENDING',
  showId: 's1',
  reservationId: 'r1',
  totalCents: 30_000,
  cancelReason: null,
  createdAt: '2031-01-01T00:00:00Z',
  confirmedAt: null,
  items: [],
  tickets: [],
  ...value,
});

describe('OrderStore', () => {
  let store: OrderStore;
  let http: HttpTestingController;

  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), OrderStore],
    });
    store = TestBed.inject(OrderStore);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const open = () => {
    store.load('o1');
    TestBed.tick();
  };

  it('consulta o pedido pendente até ele se resolver', () => {
    open();
    http.expectOne('/api/v1/orders/o1').flush(order());
    expect(store.pending()).toBe(true);

    vi.advanceTimersByTime(ORDER_POLL_MS);
    http.expectOne('/api/v1/orders/o1').flush(order());

    vi.advanceTimersByTime(ORDER_POLL_MS);
    http.expectOne('/api/v1/orders/o1').flush(
      order({
        status: 'CONFIRMED',
        tickets: [
          {
            id: 't1',
            status: 'VALID',
            sectorName: 'Pista',
            seat: null,
            issuedAt: '2031-01-01T00:00:05Z',
          },
        ],
      }),
    );
    expect(store.order()?.status).toBe('CONFIRMED');
    expect(store.pending()).toBe(false);

    // Resolvido, para de consultar.
    vi.advanceTimersByTime(ORDER_POLL_MS * 5);
    http.expectNone('/api/v1/orders/o1');
  });

  it('não consulta de novo um pedido que já chegou resolvido', () => {
    open();
    http
      .expectOne('/api/v1/orders/o1')
      .flush(order({ status: 'CANCELLED', cancelReason: 'PAYMENT_DECLINED' }));
    vi.advanceTimersByTime(ORDER_POLL_MS * 3);
    http.expectNone('/api/v1/orders/o1');
    expect(store.order()?.cancelReason).toBe('PAYMENT_DECLINED');
  });

  it('segue consultando depois de uma falha passageira', () => {
    open();
    http.expectOne('/api/v1/orders/o1').flush(order());
    vi.advanceTimersByTime(ORDER_POLL_MS);
    http.expectOne('/api/v1/orders/o1').flush(null, { status: 502, statusText: 'Bad Gateway' });
    expect(store.error()).toBeNull();
    expect(store.order()?.status).toBe('PENDING');

    vi.advanceTimersByTime(ORDER_POLL_MS);
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'CONFIRMED' }));
    expect(store.order()?.status).toBe('CONFIRMED');
  });

  it('para e mostra o erro num 404', () => {
    open();
    http
      .expectOne('/api/v1/orders/o1')
      .flush(
        { type: 'about:blank', title: 'Pedido não encontrado', status: 404 },
        { status: 404, statusText: 'Not Found' },
      );
    expect(store.error()?.status).toBe(404);
    vi.advanceTimersByTime(ORDER_POLL_MS * 3);
    http.expectNone('/api/v1/orders/o1');
  });

  it('acompanha o reembolso com menos pressa até ele terminar', () => {
    open();
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'REFUNDING' }));
    vi.advanceTimersByTime(ORDER_POLL_MS);
    http.expectNone('/api/v1/orders/o1');
    vi.advanceTimersByTime(REFUND_POLL_MS - ORDER_POLL_MS);
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'REFUNDING' }));
    vi.advanceTimersByTime(REFUND_POLL_MS);
    http
      .expectOne('/api/v1/orders/o1')
      .flush(
        order({ status: 'REFUNDED', refundedCents: 30_000, refundedAt: '2031-01-02T00:00:00Z' }),
      );
    expect(store.order()?.status).toBe('REFUNDED');
    vi.advanceTimersByTime(REFUND_POLL_MS * 3);
    http.expectNone('/api/v1/orders/o1');
  });

  it('cancela, mostra o reembolso começando e passa a acompanhá-lo', () => {
    open();
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'CONFIRMED' }));
    store.cancel();
    expect(store.cancelling()).toBe(true);
    // Um segundo clique não manda outro pedido.
    store.cancel();
    http
      .expectOne('/api/v1/orders/o1/cancel')
      .flush(order({ status: 'REFUNDING' }), { status: 202, statusText: 'Accepted' });
    expect(store.cancelling()).toBe(false);
    expect(store.order()?.status).toBe('REFUNDING');

    TestBed.tick();
    http.expectNone('/api/v1/orders/o1');
    vi.advanceTimersByTime(REFUND_POLL_MS);
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'REFUNDED' }));
    expect(store.order()?.status).toBe('REFUNDED');
  });

  it('aceita o 202 sem corpo', () => {
    open();
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'CONFIRMED' }));
    store.cancel();
    http.expectOne('/api/v1/orders/o1/cancel').flush(null, { status: 202, statusText: 'Accepted' });
    expect(store.order()?.status).toBe('REFUNDING');
    TestBed.tick();
    vi.advanceTimersByTime(REFUND_POLL_MS);
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'REFUNDING' }));
  });

  it('traduz a recusa do cancelamento e relê o pedido', () => {
    open();
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'CONFIRMED' }));
    store.cancel();
    http.expectOne('/api/v1/orders/o1/cancel').flush(
      {
        type: 'urn:lotou:problem:cancellation-not-allowed',
        title: 'Não pode',
        status: 409,
        reason: 'TICKET_USED',
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(store.cancelError()?.message).toContain('já foi usado na entrada');
    TestBed.tick();
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'CONFIRMED' }));
  });

  it('mostra a falha de rede do cancelamento sem mudar o pedido', () => {
    open();
    http.expectOne('/api/v1/orders/o1').flush(order({ status: 'CONFIRMED' }));
    store.cancel();
    http.expectOne('/api/v1/orders/o1/cancel').error(new ProgressEvent('error'));
    expect(store.cancelError()?.message).toContain('Sem conexão');
    expect(store.order()?.status).toBe('CONFIRMED');
  });
});

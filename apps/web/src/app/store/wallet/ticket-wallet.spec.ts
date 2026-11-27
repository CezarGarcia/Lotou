import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TicketWallet, WALLET_KEY } from './ticket-wallet';
import { inDays, testOrder, testShow, testTicket } from './wallet.testing';

describe('TicketWallet', () => {
  let wallet: TicketWallet;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    wallet = TestBed.inject(TicketWallet);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => localStorage.clear());

  it('sincroniza só os ingressos válidos de pedidos confirmados de shows que ainda vão acontecer', () => {
    let done = false;
    wallet.sync('comprador-1').subscribe(() => (done = true));

    http
      .expectOne((req) => req.url === '/api/v1/orders')
      .flush({
        items: [
          { id: 'o1', status: 'CONFIRMED', showId: 's1', totalCents: 1, tickets: 2, createdAt: '' },
          { id: 'o2', status: 'CANCELLED', showId: 's1', totalCents: 1, tickets: 1, createdAt: '' },
          { id: 'o3', status: 'CONFIRMED', showId: 's2', totalCents: 1, tickets: 1, createdAt: '' },
        ],
        nextCursor: null,
      });
    http
      .expectOne('/api/v1/orders/o1')
      .flush(testOrder('o1', 's1', [testTicket('t1'), testTicket('t2', 'USED')]));
    http.expectOne('/api/v1/orders/o3').flush(testOrder('o3', 's2', [testTicket('t3')]));
    http.expectOne('/api/v1/shows/s1').flush(testShow('s1', inDays(10)));
    http.expectOne('/api/v1/shows/s2').flush(testShow('s2', inDays(-3)));

    expect(done).toBe(true);
    expect(wallet.orders().map((order) => order.orderId)).toEqual(['o1']);
    expect(wallet.ticketCount()).toBe(1);
    const saved = JSON.parse(localStorage.getItem(WALLET_KEY)!);
    expect(saved.userId).toBe('comprador-1');
  });

  it('sem internet a sincronização falha sem apagar o que já estava salvo', () => {
    wallet.remember(
      'comprador-1',
      testOrder('o1', 's1', [testTicket('t1')]),
      testShow('s1', inDays(5)),
    );
    wallet.sync('comprador-1').subscribe();
    http.expectOne((req) => req.url === '/api/v1/orders').error(new ProgressEvent('offline'));
    expect(wallet.ticketCount()).toBe(1);
  });

  it('guarda o pedido confirmado na hora e o tira quando ele é cancelado', () => {
    const show = testShow('s1', inDays(5));
    wallet.remember('comprador-1', testOrder('o1', 's1', [testTicket('t1')]), show);
    expect(wallet.ticketCount()).toBe(1);
    wallet.remember(
      'comprador-1',
      testOrder('o1', 's1', [testTicket('t1', 'CANCELLED')], 'REFUNDING'),
      show,
    );
    expect(wallet.ticketCount()).toBe(0);
  });

  it('lê o que ficou salvo numa visita anterior e descarta o show que já passou', () => {
    localStorage.setItem(
      WALLET_KEY,
      JSON.stringify({
        version: 1,
        userId: 'comprador-1',
        savedAt: '2026-11-20T10:00:00Z',
        orders: [
          { orderId: 'o1', show: testShow('s1', inDays(2)), tickets: [testTicket('t1')] },
          { orderId: 'o2', show: testShow('s2', inDays(-2)), tickets: [testTicket('t2')] },
        ],
      }),
    );
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fresh = TestBed.inject(TicketWallet);
    expect(fresh.orders().map((order) => order.orderId)).toEqual(['o1']);
    expect(fresh.savedAt()).toBe('2026-11-20T10:00:00Z');
  });

  it('apaga a carteira de outra pessoa antes de guardar a de quem entrou', () => {
    wallet.remember(
      'comprador-1',
      testOrder('o1', 's1', [testTicket('t1')]),
      testShow('s1', inDays(5)),
    );
    wallet.forgetOthers('comprador-2');
    expect(wallet.ticketCount()).toBe(0);
    expect(localStorage.getItem(WALLET_KEY)).toBeNull();
  });
});

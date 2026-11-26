import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { Reservation } from '../data/sale.models';
import { ReservationStore } from './reservation.store';

const NOW = Date.UTC(2031, 0, 1, 12, 0, 0);

const reservation = (value: Partial<Reservation> = {}): Reservation => ({
  id: 'r1',
  status: 'HELD',
  showId: 's1',
  sectorId: 'pista',
  sectorName: 'Pista',
  quantity: 2,
  totalCents: 30_000,
  createdAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 9 * 60_000).toISOString(),
  items: [],
  ...value,
});

describe('ReservationStore', () => {
  let store: ReservationStore;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date', 'setInterval', 'clearInterval'] });
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ReservationStore,
        { provide: AuthService, useValue: { login: vi.fn() } },
      ],
    });
    store = TestBed.inject(ReservationStore);
    http = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    http.match(() => true).forEach((request) => request.flush({}));
    vi.useRealTimers();
  });

  /** Carrega a reserva e deixa o httpResource entregar o valor. */
  async function open(value = reservation()) {
    store.load('r1');
    TestBed.tick();
    http.expectOne('/api/v1/reservations/r1').flush(value);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    TestBed.tick();
  }

  it('conta o tempo até expiresAt e destaca os 2 últimos minutos', async () => {
    await open();
    expect(store.left()).toMatchObject({ minutes: 9, seconds: 0, done: false });
    expect(store.percentLeft()).toBe(90);
    expect(store.warning()).toBe(false);

    vi.advanceTimersByTime(7 * 60_000 + 1_000);
    expect(store.left()).toMatchObject({ minutes: 1, seconds: 59 });
    expect(store.warning()).toBe(true);
  });

  it('expira quando o cronômetro chega a zero e não deixa pagar', async () => {
    await open();
    vi.advanceTimersByTime(9 * 60_000);
    expect(store.expired()).toBe(true);
    store.pay();
    http.expectNone('/api/v1/orders');
  });

  it('paga com uma chave de idempotência e abre o pedido', async () => {
    await open();
    store.pay();
    expect(store.paying()).toBe(true);
    // Um segundo clique enquanto paga não manda outro pedido.
    store.pay();

    const request = http.expectOne('/api/v1/orders');
    expect(request.request.body).toEqual({ reservationId: 'r1' });
    expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    request.flush({ id: 'o1', status: 'PENDING' }, { status: 201, statusText: 'Created' });

    expect(navigate).toHaveBeenCalledWith(['/pedidos', 'o1'], { replaceUrl: true });
  });

  it('repete a mesma chave numa nova tentativa depois de uma falha', async () => {
    await open();
    store.pay();
    const first = http.expectOne('/api/v1/orders');
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'));
    expect(store.error()?.message).toContain('Sem conexão');

    store.pay();
    expect(http.expectOne('/api/v1/orders').request.headers.get('Idempotency-Key')).toBe(key);
  });

  it('mostra a reserva como expirada quando o servidor diz que ela não está mais segura', async () => {
    await open();
    store.pay();
    http.expectOne('/api/v1/orders').flush(
      {
        type: 'urn:lotou:problem:reservation-not-held',
        title: 'Reserva não está mais ativa',
        status: 409,
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(store.expired()).toBe(true);
    // Relê a reserva para mostrar a situação real.
    TestBed.tick();
    http.expectOne('/api/v1/reservations/r1').flush(reservation({ status: 'EXPIRED' }));
  });

  it('não trata como expirada uma reserva já paga', async () => {
    await open(reservation({ status: 'CONFIRMED' }));
    vi.advanceTimersByTime(20 * 60_000);
    expect(store.expired()).toBe(false);
  });
});

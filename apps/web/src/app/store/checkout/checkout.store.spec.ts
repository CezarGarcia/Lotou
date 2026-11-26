import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { SseMessage } from '../../core/http/sse';
import { SseClient } from '../../core/http/sse-client';
import { Reservation, ShowAvailability } from '../data/sale.models';
import { Show } from '../data/show.models';
import { CheckoutStore } from './checkout.store';

const SHOW: Show = {
  id: 's1',
  title: 'Turnê',
  artist: 'Banda',
  status: 'ON_SALE',
  startsAt: '2031-01-01T01:00:00.000Z',
  salesStartAt: null,
  highDemand: false,
  venue: null,
  priceFromCents: 10_000,
  description: '',
  doorsOpenAt: null,
  salesEndAt: null,
  sectors: [
    {
      id: 'pista',
      name: 'Pista',
      kind: 'GENERAL_ADMISSION',
      capacity: 100,
      // Preço do documento do show: a loja não usa este para cobrar.
      lots: [{ id: 'l1', name: '1º lote', priceCents: 10_000, quantity: 50, opensAt: null }],
      rows: [],
    },
    {
      id: 'cadeiras',
      name: 'Cadeiras',
      kind: 'RESERVED_SEATING',
      capacity: 3,
      lots: [{ id: 'l9', name: 'Lote único', priceCents: 20_000, quantity: 3, opensAt: null }],
      rows: [{ label: 'A', seatCount: 3 }],
    },
  ],
};

const AVAILABILITY: ShowAvailability = {
  showId: 's1',
  sectors: [
    {
      id: 'pista',
      name: 'Pista',
      kind: 'GENERAL_ADMISSION',
      capacity: 100,
      sale: 'ON_SALE',
      lot: { id: 'l2', name: '2º lote', priceCents: 15_000 },
      available: 10,
    },
    {
      id: 'cadeiras',
      name: 'Cadeiras',
      kind: 'RESERVED_SEATING',
      capacity: 3,
      sale: 'ON_SALE',
      lot: { id: 'l9', name: 'Lote único', priceCents: 20_000 },
      available: 2,
    },
  ],
};

const RESERVATION: Reservation = {
  id: 'r1',
  status: 'HELD',
  showId: 's1',
  sectorId: 'pista',
  sectorName: 'Pista',
  quantity: 2,
  totalCents: 30_000,
  expiresAt: '2031-01-01T00:10:00.000Z',
  createdAt: '2031-01-01T00:00:00.000Z',
  items: [],
};

const CPF = '529.982.247-25';

const problem = (code: string, status: number, extra: object = {}) => ({
  body: { type: `urn:lotou:problem:${code}`, title: code, status, detail: code, ...extra },
  options: { status, statusText: code },
});

describe('CheckoutStore', () => {
  let store: CheckoutStore;
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.spyOn>;
  let seatEvents: Subject<SseMessage>;
  let login: ReturnType<typeof vi.fn>;

  const flush = () => TestBed.tick();

  /** Abre o checkout de um setor e responde o show e a disponibilidade. */
  async function open(sectorId: string, show: Show = SHOW) {
    store.load('s1', sectorId);
    flush();
    http.expectOne('/api/v1/shows/s1').flush(show);
    http.expectOne('/api/v1/availability/s1').flush(AVAILABILITY);
    // O httpResource entrega o valor numa microtarefa; os efeitos rodam depois.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    flush();
  }

  beforeEach(() => {
    seatEvents = new Subject();
    login = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        CheckoutStore,
        { provide: SseClient, useValue: { connect: () => seatEvents } },
        { provide: AuthService, useValue: { login, accessToken: () => of('') } },
      ],
    });
    store = TestBed.inject(CheckoutStore);
    http = TestBed.inject(HttpTestingController);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => http.verify());

  describe('pista', () => {
    it('usa o preço do lote em venda, não o do documento do show', async () => {
      await open('pista');
      store.setQuantity(2);
      expect(store.unitPriceCents()).toBe(15_000);
      expect(store.totalCents()).toBe(30_000);
    });

    it('limita a quantidade de 1 a 4', async () => {
      await open('pista');
      store.setQuantity(9);
      expect(store.quantity()).toBe(4);
      store.setQuantity(0);
      expect(store.quantity()).toBe(1);
    });

    it('reserva com Idempotency-Key e abre a página da reserva', async () => {
      await open('pista');
      store.setQuantity(2);
      store.reserve(CPF);
      expect(store.submitting()).toBe(true);

      const request = http.expectOne('/api/v1/reservations');
      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        showId: 's1',
        sectorId: 'pista',
        cpf: '52998224725',
        quantity: 2,
      });
      expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
      request.flush(RESERVATION, { status: 201, statusText: 'Created' });

      expect(navigate).toHaveBeenCalledWith(['/reservas', 'r1']);
      expect(store.submitting()).toBe(false);
    });

    it('repete a chave depois de uma falha de rede e troca depois de uma recusa', async () => {
      await open('pista');
      store.reserve(CPF);
      const first = http.expectOne('/api/v1/reservations');
      const key = first.request.headers.get('Idempotency-Key');
      first.error(new ProgressEvent('error'));
      expect(store.error()?.message).toContain('Sem conexão');

      store.reserve(CPF);
      const retry = http.expectOne('/api/v1/reservations');
      expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
      const { body, options } = problem('sales-paused', 409);
      retry.flush(body, options);
      // A recusa pede uma nova consulta da disponibilidade.
      http.expectOne('/api/v1/availability/s1').flush(AVAILABILITY);

      store.reserve(CPF);
      const next = http.expectOne('/api/v1/reservations');
      expect(next.request.headers.get('Idempotency-Key')).not.toBe(key);
      next.flush(RESERVATION, { status: 201, statusText: 'Created' });
    });

    it('mostra quantos restam e ajusta a quantidade no estoque insuficiente', async () => {
      await open('pista');
      store.setQuantity(4);
      store.reserve(CPF);
      const { body, options } = problem('insufficient-stock', 409, { available: 2 });
      http.expectOne('/api/v1/reservations').flush(body, options);
      http.expectOne('/api/v1/availability/s1').flush(AVAILABILITY);

      expect(store.error()?.message).toContain('Só restam 2 ingressos');
      expect(store.quantity()).toBe(2);
    });

    it('explica o limite por CPF', async () => {
      await open('pista');
      store.reserve(CPF);
      const { body, options } = problem('purchase-limit-exceeded', 409, { remaining: 1 });
      http.expectOne('/api/v1/reservations').flush(body, options);
      expect(store.error()?.message).toContain('ainda pode comprar 1 ingresso');
    });

    it('volta para a fila quando a reserva exige admissão', async () => {
      await open('pista');
      store.reserve(CPF);
      const { body, options } = problem('queue-admission-required', 403);
      http.expectOne('/api/v1/reservations').flush(body, options);

      expect(navigate).toHaveBeenCalledWith(['/shows', 's1', 'fila'], {
        queryParams: { setor: 'pista' },
        replaceUrl: true,
      });
    });

    it('bloqueia o botão pelo tempo do Retry-After depois de um 429', async () => {
      await open('pista');
      store.reserve(CPF);
      http.expectOne('/api/v1/reservations').flush(problem('rate-limited', 429).body, {
        status: 429,
        statusText: 'Too Many Requests',
        headers: { 'Retry-After': '30' },
      });
      expect(store.cooldown()).toBeGreaterThan(0);
      expect(store.canReserve()).toBe(false);
      expect(store.error()?.message).toContain('Aguarde 30 segundos');
    });

    it('leva ao login quando a sessão expirou', async () => {
      await open('pista');
      store.reserve(CPF);
      http
        .expectOne('/api/v1/reservations')
        .flush(null, { status: 401, statusText: 'Unauthorized' });
      expect(login).toHaveBeenCalled();
    });
  });

  describe('cadeira numerada', () => {
    const seats = (...labels: string[]) =>
      ({
        event: 'seats',
        data: JSON.stringify({ sectorId: 'cadeiras', seats: labels, available: false }),
      }) as SseMessage;

    async function openSeats() {
      await open('cadeiras');
      http.expectOne('/api/v1/availability/s1/sectors/cadeiras/seats').flush({
        showId: 's1',
        sectorId: 'cadeiras',
        seats: [
          { label: 'A-1', available: true },
          { label: 'A-2', available: true },
          { label: 'A-3', available: false },
        ],
      });
      return store.seatMap()!;
    }

    it('monta o mapa com as fileiras do show e a foto do setor', async () => {
      const map = await openSeats();
      expect(map.loaded()).toBe(true);
      expect(map.seat('A-3')!.available()).toBe(false);
      expect(store.seated()).toBe(true);
    });

    it('tira da seleção a cadeira que outra pessoa pegou e avisa', async () => {
      const map = await openSeats();
      store.toggleSeat('A-1');
      store.toggleSeat('A-2');
      expect(store.totalCents()).toBe(40_000);

      seatEvents.next(seats('A-2'));
      expect(map.selected()).toEqual(['A-1']);
      expect(store.notice()).toBe(
        'A cadeira A-2 foi reservada por outra pessoa e saiu da sua seleção.',
      );
      expect(store.totalCents()).toBe(20_000);
    });

    it('reserva as cadeiras escolhidas, tudo ou nada', async () => {
      await openSeats();
      store.toggleSeat('A-2');
      store.toggleSeat('A-1');
      store.reserve(CPF);

      const request = http.expectOne('/api/v1/reservations');
      expect(request.request.body).toEqual({
        showId: 's1',
        sectorId: 'cadeiras',
        cpf: '52998224725',
        seats: ['A-1', 'A-2'],
      });
      const { body, options } = problem('seat-unavailable', 409, { seats: ['A-2'] });
      request.flush(body, options);

      expect(store.seatMap()!.selected()).toEqual(['A-1']);
      expect(store.seatMap()!.seat('A-2')!.available()).toBe(false);
      expect(store.error()?.message).toContain('A cadeira A-2 acabou de ser reservada');
    });

    it('avisa quando a cadeira não está livre ou o limite foi atingido', async () => {
      await openSeats();
      store.toggleSeat('A-3');
      expect(store.notice()).toBe('A cadeira A-3 não está livre.');
    });
  });

  describe('alta demanda', () => {
    it('manda para a fila quem não foi admitido', async () => {
      await open('pista', { ...SHOW, highDemand: true });
      http.expectOne('/api/v1/queue/s1').flush({ showId: 's1', status: 'QUEUED', position: 10 });

      expect(navigate).toHaveBeenCalledWith(['/shows', 's1', 'fila'], {
        queryParams: { setor: 'pista' },
        replaceUrl: true,
      });
    });

    it('mostra quanto tempo resta da admissão', async () => {
      const admittedUntil = new Date(Date.now() + 4 * 60_000 - 500).toISOString();
      await open('pista', { ...SHOW, highDemand: true });
      http.expectOne('/api/v1/queue/s1').flush({ showId: 's1', status: 'ADMITTED', admittedUntil });

      expect(navigate).not.toHaveBeenCalled();
      expect(store.admissionLeft()?.minutes).toBe(3);
      expect(store.canReserve()).toBe(true);
    });
  });

  describe('estoque carregando', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('tenta de novo sozinho, com a mesma chave', async () => {
      await open('pista');
      store.reserve(CPF);
      const first = http.expectOne('/api/v1/reservations');
      const key = first.request.headers.get('Idempotency-Key');
      first.flush(problem('inventory-loading', 503).body, {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Retry-After': '1' },
      });
      expect(store.submitting()).toBe(true);

      vi.advanceTimersByTime(1_000);
      const retry = http.expectOne('/api/v1/reservations');
      expect(retry.request.headers.get('Idempotency-Key')).toBe(key);
      retry.flush(RESERVATION, { status: 201, statusText: 'Created' });
      expect(navigate).toHaveBeenCalledWith(['/reservas', 'r1']);
    });
  });
});

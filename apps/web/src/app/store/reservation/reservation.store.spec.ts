import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { OrderQuote, Reservation } from '../data/sale.models';
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

const quote = (value: Partial<OrderQuote> = {}): OrderQuote => ({
  subtotalCents: 30_000,
  discountCents: 0,
  serviceFeeCents: 3_000,
  serviceFeePaidBy: 'BUYER',
  totalCents: 33_000,
  coupon: null,
  ...value,
});

const couponInvalid = (reason: string) => ({
  type: 'urn:lotou:problem:coupon-invalid',
  title: 'Cupom inválido',
  status: 422,
  reason,
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

  /** Responde ao orçamento pendente. */
  function answerQuote(body: object = quote(), status = 200) {
    const request = http.expectOne('/api/v1/orders/quote');
    request.flush(body, { status, statusText: status === 200 ? 'OK' : 'Erro' });
    return request.request.body as Record<string, unknown>;
  }

  /** Reserva aberta e orçamento sem cupom carregado: pronta para pagar. */
  async function ready(value = quote()) {
    await open();
    expect(answerQuote(value)).toEqual({ reservationId: 'r1' });
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

  it('pede o orçamento da reserva e não deixa pagar antes de ter o total', async () => {
    await open();
    store.pay();
    http.expectNone('/api/v1/orders');
    expect(store.canPay()).toBe(false);

    answerQuote();
    expect(store.quote()?.totalCents).toBe(33_000);
    expect(store.canPay()).toBe(true);
  });

  it('mostra a falha do orçamento e tenta de novo', async () => {
    await open();
    answerQuote({ title: 'Falhou', status: 503 }, 503);
    expect(store.quoteError()?.message).toBe('Falhou');
    expect(store.canPay()).toBe(false);

    store.retryQuote();
    answerQuote();
    expect(store.quoteError()).toBeNull();
    expect(store.canPay()).toBe(true);
  });

  it('aplica o cupom com o código normalizado e paga com ele', async () => {
    await ready();
    store.applyCoupon('  lancamento 10 ');
    expect(store.checkingCoupon()).toBe(true);
    expect(store.canPay()).toBe(false);
    expect(
      answerQuote(
        quote({
          discountCents: 3_000,
          totalCents: 30_000,
          coupon: { code: 'LANCAMENTO10', kind: 'PERCENT', percent: 10, amountCents: null },
        }),
      ),
    ).toEqual({ reservationId: 'r1', couponCode: 'LANCAMENTO10' });
    expect(store.coupon()?.code).toBe('LANCAMENTO10');
    expect(store.couponError()).toBeNull();

    store.pay();
    const request = http.expectOne('/api/v1/orders');
    expect(request.request.body).toEqual({ reservationId: 'r1', couponCode: 'LANCAMENTO10' });
  });

  it.each([
    ['NOT_FOUND', 'Não encontramos esse cupom'],
    ['EXPIRED', 'prazo dele acabou'],
    ['PAUSED', 'pausado pelo produtor'],
    ['EXHAUSTED', 'máximo de vezes'],
    ['WRONG_SHOW', 'não vale para este show'],
    ['WRONG_SECTOR', 'não vale para o setor'],
  ])('recusa o cupom %s com uma mensagem clara e mantém o total', async (reason, text) => {
    await ready();
    store.applyCoupon('XYZ');
    answerQuote(couponInvalid(reason), 422);
    expect(store.couponError()).toContain(text);
    expect(store.coupon()).toBeNull();
    expect(store.quote()?.totalCents).toBe(33_000);
    expect(store.canPay()).toBe(true);
  });

  it('não confere cupom vazio', async () => {
    await ready();
    store.applyCoupon('   ');
    http.expectNone('/api/v1/orders/quote');
    expect(store.couponError()).toBe('Digite o código do cupom.');
  });

  it('o último cupom digitado vence uma resposta atrasada', async () => {
    await ready();
    store.applyCoupon('PRIMEIRO');
    store.applyCoupon('SEGUNDO');
    const [first, second] = http.match('/api/v1/orders/quote');
    expect(first.cancelled).toBe(true);
    second.flush(
      quote({ coupon: { code: 'SEGUNDO', kind: 'AMOUNT', percent: null, amountCents: 500 } }),
    );
    expect(store.coupon()?.code).toBe('SEGUNDO');
  });

  it('remove o cupom e volta ao total sem desconto', async () => {
    await ready();
    store.applyCoupon('DEZ');
    answerQuote(
      quote({ coupon: { code: 'DEZ', kind: 'PERCENT', percent: 10, amountCents: null } }),
    );
    store.removeCoupon();
    expect(answerQuote()).toEqual({ reservationId: 'r1' });
    expect(store.coupon()).toBeNull();
  });

  it('cupom que esgota entre o orçamento e o pedido sai do pedido, com aviso', async () => {
    await ready();
    store.applyCoupon('ULTIMO');
    answerQuote(
      quote({ coupon: { code: 'ULTIMO', kind: 'PERCENT', percent: 50, amountCents: null } }),
    );
    store.pay();
    const first = http.expectOne('/api/v1/orders');
    first.flush(couponInvalid('EXHAUSTED'), { status: 422, statusText: 'Unprocessable' });

    expect(store.error()?.message).toContain('máximo de vezes');
    expect(store.error()?.message).toContain('confira o novo total');
    // Sem total, não paga até o orçamento sem cupom chegar.
    expect(store.canPay()).toBe(false);
    expect(answerQuote()).toEqual({ reservationId: 'r1' });
    expect(store.coupon()).toBeNull();

    // A nova tentativa, sem cupom, leva outra chave.
    store.pay();
    const second = http.expectOne('/api/v1/orders');
    expect(second.request.body).toEqual({ reservationId: 'r1' });
    expect(second.request.headers.get('Idempotency-Key')).not.toBe(
      first.request.headers.get('Idempotency-Key'),
    );
  });

  it('paga com uma chave de idempotência e abre o pedido', async () => {
    await ready();
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
    await ready();
    store.pay();
    const first = http.expectOne('/api/v1/orders');
    const key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'));
    expect(store.error()?.message).toContain('Sem conexão');

    store.pay();
    expect(http.expectOne('/api/v1/orders').request.headers.get('Idempotency-Key')).toBe(key);
  });

  it('mostra a reserva como expirada quando o servidor diz que ela não está mais segura', async () => {
    await ready();
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

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { OrderQuote, Reservation } from '../data/sale.models';
import { ReservationPage } from './reservation.page';

const reservation = (value: Partial<Reservation>): Reservation => ({
  id: 'r1',
  status: 'HELD',
  showId: 's1',
  sectorId: 'plateia',
  sectorName: 'Plateia',
  quantity: 2,
  totalCents: 24_000,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 9 * 60_000 + 30_000).toISOString(),
  items: [
    { lotId: 'l1', lotName: '1º lote', seat: 'A-1', unitPriceCents: 12_000 },
    { lotId: 'l1', lotName: '1º lote', seat: 'A-2', unitPriceCents: 12_000 },
  ],
  ...value,
});

/** O documento do show, para o cabeçalho da tela. */
const SHOW = {
  id: 's1',
  title: 'Turnê',
  artist: 'Banda',
  startsAt: '2031-01-01T01:00:00.000Z',
  venue: { id: 'v1', name: 'Arena', city: 'Recife', state: 'PE', timezone: 'America/Recife' },
  sectors: [],
};

/**
 * Deixa as respostas e os efeitos assentarem. O `whenStable` esperaria todas as
 * requisições pendentes, e o documento do show é pedido no meio do caminho.
 */
async function settle(fixture: { detectChanges(): void }) {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
  fixture.detectChanges();
}

const QUOTE: OrderQuote = {
  subtotalCents: 24_000,
  discountCents: 0,
  serviceFeeCents: 2_400,
  serviceFeePaidBy: 'BUYER',
  totalCents: 26_400,
  coupon: null,
};

const plain = (text: string) => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');

describe('ReservationPage', () => {
  async function render(value: Reservation, quote?: OrderQuote) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: AuthService, useValue: { login: vi.fn() } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ReservationPage);
    fixture.componentRef.setInput('id', 'r1');
    fixture.detectChanges();
    http.expectOne('/api/v1/reservations/r1').flush(value);
    await settle(fixture);
    http.expectOne('/api/v1/shows/s1').flush(SHOW);
    await settle(fixture);
    if (quote) {
      http.expectOne('/api/v1/orders/quote').flush(quote);
      await settle(fixture);
    }
    const element = fixture.nativeElement as HTMLElement;
    return { element, http, fixture, text: () => plain(element.textContent!) };
  }

  it('mostra ingressos, taxa de serviço e total quando a taxa é do comprador', async () => {
    const { element, text } = await render(reservation({}), QUOTE);
    const rows = [...element.querySelectorAll('.breakdown > div')].map(
      (row) =>
        `${plain(row.querySelector('dt')!.textContent!).trim()} = ${plain(row.querySelector('dd')!.textContent!).trim()}`,
    );
    expect(rows).toEqual([
      '2 ingressos = R$ 240,00',
      'Taxa de serviço 10% do valor dos ingressos = R$ 24,00',
      'Total = R$ 264,00',
    ]);
    expect(plain(element.querySelector('.cta')!.textContent!)).toContain('Pagar R$ 264,00');
    expect(text()).not.toContain('por conta do produtor');
  });

  it('não cobra taxa quando o produtor a absorve, e diz isso com discrição', async () => {
    const { element, text } = await render(reservation({}), {
      ...QUOTE,
      serviceFeePaidBy: 'PRODUCER',
      serviceFeeCents: 2_400,
      totalCents: 24_000,
    });
    expect(text()).not.toContain('Taxa de serviço 10%');
    expect(element.querySelector('.fee-note')!.textContent).toContain('por conta do produtor');
    expect(plain(element.querySelector('.cta')!.textContent!)).toContain('Pagar R$ 240,00');
  });

  it('abre o campo de cupom, aplica e mostra o desconto com o código', async () => {
    const { element, http, fixture, text } = await render(reservation({}), QUOTE);
    const toggle = [...element.querySelectorAll('button')].find((button) =>
      button.textContent!.includes('Tenho um cupom'),
    )!;
    toggle.click();
    fixture.detectChanges();
    const input = element.querySelector<HTMLInputElement>('#coupon-form input')!;
    input.value = 'amigos20';
    input.dispatchEvent(new Event('input'));
    element.querySelector<HTMLFormElement>('#coupon-form')!.dispatchEvent(new Event('submit'));
    const request = http.expectOne('/api/v1/orders/quote');
    expect(request.request.body).toEqual({ reservationId: 'r1', couponCode: 'AMIGOS20' });
    request.flush({
      ...QUOTE,
      discountCents: 4_800,
      totalCents: 21_600,
      coupon: { code: 'AMIGOS20', kind: 'PERCENT', percent: 20, amountCents: null },
    });
    await settle(fixture);
    const discount = element.querySelector('.discount')!;
    expect(plain(discount.querySelector('dt')!.textContent!).trim()).toBe('Desconto AMIGOS20');
    expect(plain(discount.querySelector('dd')!.textContent!).trim()).toBe('− R$ 48,00');
    expect(text()).toContain('Cupom AMIGOS20 aplicado');
    expect(text()).toContain('Novo total: R$ 216,00');
  });

  it('mostra o motivo de um cupom recusado junto do campo', async () => {
    const { element, http, fixture } = await render(reservation({}), QUOTE);
    [...element.querySelectorAll('button')]
      .find((button) => button.textContent!.includes('Tenho um cupom'))!
      .click();
    fixture.detectChanges();
    const input = element.querySelector<HTMLInputElement>('#coupon-form input')!;
    input.value = 'VELHO';
    input.dispatchEvent(new Event('input'));
    element.querySelector<HTMLFormElement>('#coupon-form')!.dispatchEvent(new Event('submit'));
    http.expectOne('/api/v1/orders/quote').flush(
      {
        type: 'urn:lotou:problem:coupon-invalid',
        title: 'Cupom inválido',
        status: 422,
        reason: 'EXPIRED',
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await settle(fixture);
    const error = element.querySelector('.coupon-error')!;
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain('prazo dele acabou');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('mostra o cronômetro, as cadeiras e o botão de pagar', async () => {
    const { element, text } = await render(reservation({}));
    expect(element.querySelector('[role="timer"]')!.textContent).toMatch(/^09:[23]\d$/);
    expect(text()).toContain('Cadeira A-1');
    expect(text()).toContain('Faltam 10 minutos');
    expect(element.querySelector('.cta')!.textContent).toContain('Pagar');
  });

  it('mostra a reserva expirada com o caminho de volta', async () => {
    const { element, text } = await render(
      reservation({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
    );
    expect(text()).toContain('Sua reserva expirou');
    expect(element.querySelector('a[href="/shows/s1"]')).not.toBeNull();
    expect(element.querySelector('.cta')).toBeNull();
  });
});

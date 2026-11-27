import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Coupon } from '../data/coupons.api';
import { ProducerShowContext } from '../show/show-context';
import { CouponsPage } from './coupons.page';

const SHOW = {
  id: 's1',
  title: 'Turnê',
  artist: 'Banda',
  status: 'ON_SALE',
  startsAt: '2031-01-01T01:00:00.000Z',
  venue: { id: 'v1', name: 'Arena', city: 'Recife', state: 'PE', timezone: 'America/Recife' },
  sectors: [
    { id: 'pista', name: 'Pista', kind: 'GENERAL_ADMISSION', capacity: 100, lots: [], rows: [] },
    {
      id: 'camarote',
      name: 'Camarote',
      kind: 'GENERAL_ADMISSION',
      capacity: 10,
      lots: [],
      rows: [],
    },
  ],
};

const coupon = (value: Partial<Coupon> = {}): Coupon => ({
  id: 'c1',
  showId: 's1',
  code: 'LANCAMENTO10',
  kind: 'PERCENT',
  percent: 10,
  amountCents: null,
  maxUses: 100,
  uses: 37,
  remaining: 63,
  status: 'ACTIVE',
  validUntil: '2031-01-01T02:59:00Z',
  sectorIds: [],
  discountGivenCents: 123_400,
  createdAt: '2030-12-01T00:00:00Z',
  ...value,
});

const plain = (text: string) => text.replace(/ /g, ' ').replace(/\s+/g, ' ');

describe('CouponsPage', () => {
  let fixture: ComponentFixture<CouponsPage>;
  let http: HttpTestingController;
  let snack: ReturnType<typeof vi.fn>;

  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => plain(element().textContent!);

  async function settle() {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    fixture.detectChanges();
  }

  async function render(coupons: object = { items: [coupon()], nextCursor: null }) {
    snack = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        ProducerShowContext,
        { provide: MatSnackBar, useValue: { open: snack } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ProducerShowContext).id.set('s1');
    fixture = TestBed.createComponent(CouponsPage);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/v1/shows/s1').flush(SHOW);
    http
      .expectOne((r) => r.url === '/api/v1/coupons' && r.params.get('showId') === 's1')
      .flush(coupons);
    await settle();
  }

  const button = (label: string) =>
    [...element().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent!.includes(label),
    );

  function fill(selector: string, value: string) {
    const input = element().querySelector<HTMLInputElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('mostra cada cupom com usos, restantes, desconto dado e validade no fuso do show', async () => {
    await render({
      items: [
        coupon(),
        coupon({
          id: 'c2',
          code: 'VIP30',
          kind: 'AMOUNT',
          percent: null,
          amountCents: 3_000,
          status: 'PAUSED',
          sectorIds: ['camarote'],
        }),
      ],
    });
    const cards = element().querySelectorAll('.coupon');
    expect(cards).toHaveLength(2);
    const first = plain(cards[0].textContent!);
    expect(first).toContain('LANCAMENTO10');
    expect(first).toContain('Ativo');
    expect(first).toContain('10% de desconto nos ingressos');
    expect(first).toContain('Todos os setores · válido até 31/12/2030 às 23:59');
    expect(first).toContain('37 de 100');
    expect(first).toContain('R$ 1.234,00');
    expect(cards[0].querySelector('[role="meter"]')!.getAttribute('aria-valuetext')).toBe(
      '37 de 100 usos (37%)',
    );
    const second = plain(cards[1].textContent!);
    expect(second).toContain('R$ 30,00 de desconto por pedido');
    expect(second).toContain('Só Camarote');
    expect(second).toContain('Pausado');
    expect(second).toContain('Retomar');
  });

  it('pausa e troca o cupom pelo que o servidor devolve', async () => {
    await render();
    button('Pausar')!.click();
    const request = http.expectOne('/api/v1/coupons/c1/pause');
    expect(request.request.method).toBe('POST');
    request.flush(coupon({ status: 'PAUSED' }));
    await settle();
    expect(text()).toContain('Pausado');
    expect(button('Retomar')).toBeDefined();
  });

  it('cria um cupom de valor fixo, em centavos, com chave de idempotência', async () => {
    await render({ items: [] });
    expect(text()).toContain('Nenhum cupom ainda');
    button('Novo cupom')!.click();
    await settle();
    // A validade começa no início do show, no fuso do local.
    expect(element().querySelector<HTMLInputElement>('input[type="datetime-local"]')!.value).toBe(
      '2030-12-31T22:00',
    );
    fill('input[formcontrolname="code"]', 'amigos 30');
    expect(element().querySelector<HTMLInputElement>('input[formcontrolname="code"]')!.value).toBe(
      'AMIGOS30',
    );
    element().querySelectorAll<HTMLInputElement>('mat-radio-button input')[1].click();
    await settle();
    fill('input[formcontrolname="amount"]', '30,5');
    fill('input[formcontrolname="maxUses"]', '50');
    element().querySelectorAll<HTMLInputElement>('mat-checkbox input')[0].click();
    await settle();
    button('Criar cupom')!.click();

    const request = http.expectOne((r) => r.method === 'POST' && r.url === '/api/v1/coupons');
    expect(request.request.body).toEqual({
      showId: 's1',
      code: 'AMIGOS30',
      kind: 'AMOUNT',
      amountCents: 3_050,
      maxUses: 50,
      validUntil: '2031-01-01T01:00:00.000Z',
      sectorIds: ['pista'],
    });
    expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    request.flush(
      coupon({ code: 'AMIGOS30', kind: 'AMOUNT', amountCents: 3_050, uses: 0, remaining: 50 }),
    );
    await settle();
    expect(snack).toHaveBeenCalledWith('Cupom AMIGOS30 criado.', 'OK', { duration: 5_000 });
    expect(element().querySelectorAll('.coupon')).toHaveLength(1);
    expect(element().querySelector('app-coupon-form')).toBeNull();
  });

  it('não envia com campos inválidos e mostra o porquê', async () => {
    await render({ items: [] });
    button('Novo cupom')!.click();
    await settle();
    fill('input[formcontrolname="code"]', 'ab');
    fill('input[formcontrolname="percent"]', '150');
    button('Criar cupom')!.click();
    await settle();
    http.expectNone((r) => r.method === 'POST');
    expect(text()).toContain('De 3 a 30 caracteres');
    expect(text()).toContain('Um número inteiro de 1 a 100.');
  });

  it('código repetido aparece no campo', async () => {
    await render({ items: [] });
    button('Novo cupom')!.click();
    await settle();
    fill('input[formcontrolname="code"]', 'REPETIDO');
    button('Criar cupom')!.click();
    http
      .expectOne((r) => r.method === 'POST')
      .flush(
        { type: 'urn:lotou:problem:coupon-code-taken', title: 'Código em uso', status: 409 },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();
    expect(text()).toContain('Já existe um cupom com esse código neste show.');
    expect(element().querySelector('app-coupon-form')).not.toBeNull();
  });
});

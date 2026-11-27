import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { toStatement } from '../data/finance.api';
import { ProducerShowContext } from '../show/show-context';
import { FinancePage, composition } from './finance.page';
import { statementLines } from './finance.store';

const SHOW = {
  id: 's1',
  title: 'Turnê',
  artist: 'Banda',
  status: 'ON_SALE',
  startsAt: '2031-01-01T01:00:00.000Z',
  venue: { id: 'v1', name: 'Arena', city: 'Recife', state: 'PE', timezone: 'America/Recife' },
  sectors: [],
};

const STATEMENT = {
  grossSalesCents: 1_000_000,
  discountsCents: 50_000,
  refundsCents: 30_000,
  platformFeeCents: 100_000,
  buyerFeesCents: 0,
  receivableCents: 820_000,
  refundedOrders: 2,
  partial: true,
};

const plain = (text: string) => text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

describe('statementLines', () => {
  it('segue a fórmula, com o sinal de cada linha', () => {
    const lines = statementLines(toStatement(STATEMENT));
    expect(lines.map((line) => [line.label, line.sign, line.cents])).toEqual([
      ['Vendas brutas', '', 1_000_000],
      ['Descontos de cupom', '-', 50_000],
      ['Reembolsos', '-', 30_000],
      ['Taxa de serviço absorvida', '-', 100_000],
    ]);
    expect(lines[2].explanation).toContain('2 pedidos reembolsados');
  });

  it('campo ausente vale zero; sem "partial", conta como parcial', () => {
    expect(toStatement({ grossSalesCents: 10 })).toMatchObject({
      grossSalesCents: 10,
      discountsCents: 0,
      partial: true,
    });
    expect(toStatement({ partial: false }).partial).toBe(false);
  });
});

describe('composition', () => {
  it('divide as vendas brutas entre o que fica e cada desconto, sem as partes vazias', () => {
    const parts = composition(
      toStatement({
        grossSalesCents: 10_000,
        discountsCents: 500,
        refundsCents: 0,
        platformFeeCents: 1_000,
        receivableCents: 8_500,
      }),
    )!;
    expect(parts.segments.map((part) => [part.key, part.percentText])).toEqual([
      ['receivableCents', '85%'],
      ['discountsCents', '5%'],
      ['platformFeeCents', '10%'],
    ]);
    expect(plain(parts.label)).toBe(
      'Das vendas brutas: a receber R$ 85,00, descontos R$ 5,00, taxa R$ 10,00',
    );
  });

  it('sem vendas, não há barra', () => {
    expect(composition(toStatement({}))).toBeNull();
  });
});

describe('FinancePage', () => {
  let fixture: ComponentFixture<FinancePage>;
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

  async function render(statement: object = STATEMENT, refunds: object = { items: [] }) {
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
    fixture = TestBed.createComponent(FinancePage);
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/v1/shows/s1').flush(SHOW);
    http.expectOne('/api/v1/analytics/shows/s1/statement').flush(statement);
    http.expectOne((r) => r.url === '/api/v1/orders/refund-failed').flush(refunds);
    await settle();
  }

  const button = (label: string) =>
    [...element().querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent!.includes(label),
    )!;

  it('mostra cada linha do relatório, o valor a receber e a fórmula', async () => {
    await render();
    const lines = [...element().querySelectorAll('.statement .line')].map((line) => [
      plain(line.querySelector('.label')!.textContent!),
      plain(line.querySelector('dd')!.textContent!),
    ]);
    expect(lines).toEqual([
      ['Vendas brutas', 'R$ 10.000,00'],
      ['−Descontos de cupom', 'menos− R$ 500,00'],
      ['−Reembolsos', 'menos− R$ 300,00'],
      ['−Taxa de serviço absorvida', 'menos− R$ 1.000,00'],
      ['Valor a receber', 'R$ 8.200,00'],
    ]);
    expect(text()).toContain(
      'Vendas brutas − descontos − reembolsos − taxa absorvida: R$ 10.000,00 − R$ 500,00 − R$ 300,00 − R$ 1.000,00',
    );
    expect(element().querySelector('.badge')!.textContent!.trim()).toBe('Parcial');
    expect(text()).toContain('enquanto o show não acontece');
    expect(text()).toContain('Nenhum reembolso travado.');
  });

  it('relatório final', async () => {
    await render({ ...STATEMENT, partial: false });
    expect(element().querySelector('.badge')!.textContent!.trim()).toBe('Final');
  });

  it('pede o PDF por e-mail e avisa', async () => {
    await render();
    button('Receber PDF por e-mail').click();
    const request = http.expectOne('/api/v1/reports/statements');
    expect(request.request.body).toEqual({ showId: 's1' });
    request.flush(null, { status: 202, statusText: 'Accepted' });
    expect(snack).toHaveBeenCalledWith(
      'Pedido recebido. O PDF do relatório chega no seu e-mail em alguns minutos.',
      'OK',
      { duration: 8_000 },
    );
  });

  it('lista os reembolsos travados e manda de novo', async () => {
    await render(STATEMENT, {
      items: [
        {
          id: '0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
          showId: 's1',
          totalCents: 33_000,
          tickets: 2,
          createdAt: '2030-12-10T15:00:00Z',
          confirmedAt: '2030-12-10T15:00:05Z',
        },
      ],
    });
    expect(text()).toContain('Pedido ffff0000');
    expect(text()).toContain('R$ 330,00 · 2 ingressos · comprado em 10/12/2030');
    button('Tentar reembolso de novo').click();
    http
      .expectOne('/api/v1/orders/0193aaaa-bbbb-7ccc-8ddd-eeeeffff0000/refund/retry')
      .flush(null, { status: 202, statusText: 'Accepted' });
    await settle();
    expect(text()).toContain('Nenhum reembolso travado.');
    expect(snack).toHaveBeenCalledWith('Reembolso do pedido ffff0000 enviado de novo.', 'OK', {
      duration: 6_000,
    });
  });

  it('mostra o erro do relatório e tenta de novo', async () => {
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
    fixture = TestBed.createComponent(FinancePage);
    fixture.detectChanges();
    await settle();
    http
      .expectOne('/api/v1/analytics/shows/s1/statement')
      .flush({ title: 'Fora do ar', status: 503 }, { status: 503, statusText: 'Unavailable' });
    await settle();
    expect(text()).toContain('Não foi possível carregar o relatório. Fora do ar');
    button('Tentar de novo').click();
    await settle();
    http.expectOne('/api/v1/analytics/shows/s1/statement').flush(STATEMENT);
    await settle();
    expect(text()).toContain('R$ 8.200,00');
  });
});

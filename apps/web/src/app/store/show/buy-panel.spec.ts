import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SaleState, ShowAvailability } from '../data/sale.models';
import { Show } from '../data/show.models';
import { AvailabilityState } from '../shared/live-availability';
import { BuyPanel } from './buy-panel';

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
    { id: 'pista', name: 'Pista', kind: 'GENERAL_ADMISSION', capacity: 10, lots: [], rows: [] },
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

const availability = (pista: SaleState, camarote: SaleState): AvailabilityState => {
  const sector = (id: string, sale: SaleState, priceCents: number) => ({
    id,
    name: id,
    kind: 'GENERAL_ADMISSION' as const,
    capacity: 10,
    sale,
    lot: sale === 'ON_SALE' ? { id: `${id}-lot`, name: '2º lote', priceCents } : null,
    available: sale === 'ON_SALE' ? 5 : 0,
  });
  const value: ShowAvailability = {
    showId: 's1',
    sectors: [sector('pista', pista, 15_000), sector('camarote', camarote, 40_000)],
  };
  return { value, error: null, loaded: true };
};

describe('BuyPanel', () => {
  const roles = signal<string[]>(['buyer']);
  const authenticated = signal(true);

  async function render(show: Show, state: AvailabilityState) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            authenticated,
            roles,
            hasRole: (role: string) => roles().includes(role),
          },
        },
      ],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(BuyPanel);
    fixture.componentRef.setInput('show', show);
    fixture.componentRef.setInput('availability', state);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = () => element.textContent!.replace(/\s+/g, ' ');
    const button = () => element.querySelector<HTMLButtonElement>('.cta')!;
    const radio = (id: string) => element.querySelector<HTMLInputElement>(`input[value="${id}"]`)!;
    return { fixture, element, text, button, radio, navigate };
  }

  beforeEach(() => {
    roles.set(['buyer']);
    authenticated.set(true);
  });

  it('mostra o preço do lote em venda e o menor preço do show', async () => {
    const { text, element } = await render(SHOW, availability('ON_SALE', 'ON_SALE'));
    expect(text()).toContain('Ingressos a partir de');
    // O Intl separa "R$" do valor com um espaço não separável.
    expect(element.querySelector('.from strong')!.textContent).toContain('R$\u00a0150,00');
    expect(text()).toContain('R$ 400,00');
  });

  it('só deixa escolher setor à venda e leva ao checkout', async () => {
    const { fixture, radio, button, navigate } = await render(
      SHOW,
      availability('ON_SALE', 'SOLD_OUT'),
    );
    expect(radio('camarote').disabled).toBe(true);
    expect(button().disabled).toBe(true);

    radio('pista').click();
    await fixture.whenStable();
    expect(button().disabled).toBe(false);
    button().click();
    expect(navigate).toHaveBeenCalledWith(['/shows', 's1', 'comprar', 'pista']);
  });

  it('em alta demanda, leva à fila com o setor escolhido, mesmo antes da abertura', async () => {
    const { fixture, radio, button, text, navigate } = await render(
      { ...SHOW, highDemand: true, salesStartAt: '2999-01-01T13:00:00.000Z' },
      availability('NOT_OPEN', 'NOT_OPEN'),
    );
    expect(text()).toContain('posição sorteada');
    expect(button().textContent).toContain('Entrar na fila');

    radio('camarote').click();
    await fixture.whenStable();
    button().click();
    expect(navigate).toHaveBeenCalledWith(['/shows', 's1', 'fila'], {
      queryParams: { setor: 'camarote' },
    });
  });

  it('explica quando está tudo esgotado', async () => {
    const { text, button } = await render(SHOW, availability('SOLD_OUT', 'SOLD_OUT'));
    expect(text()).toContain('Ingressos esgotados.');
    expect(button().disabled).toBe(true);
  });

  it('avisa a conta que não é de comprador', async () => {
    roles.set(['producer']);
    const { fixture, radio, button, text } = await render(SHOW, availability('ON_SALE', 'ON_SALE'));
    radio('pista').click();
    await fixture.whenStable();
    expect(button().disabled).toBe(true);
    expect(text()).toContain('Sua conta não é de comprador');
  });
});

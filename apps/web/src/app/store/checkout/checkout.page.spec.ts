import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { NEVER, of } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { SseClient } from '../../core/http/sse-client';
import { ShowAvailability } from '../data/sale.models';
import { Show } from '../data/show.models';
import { CheckoutPage } from './checkout.page';

const SHOW: Show = {
  id: 's1',
  title: 'Turnê',
  artist: 'Banda',
  status: 'ON_SALE',
  startsAt: '2031-01-01T01:00:00.000Z',
  salesStartAt: null,
  highDemand: false,
  venue: { id: 'v1', name: 'Arena', city: 'Recife', state: 'PE', timezone: 'America/Recife' },
  priceFromCents: 10_000,
  description: '',
  doorsOpenAt: null,
  salesEndAt: null,
  sectors: [
    { id: 'pista', name: 'Pista', kind: 'GENERAL_ADMISSION', capacity: 10, lots: [], rows: [] },
    {
      id: 'plateia',
      name: 'Plateia',
      kind: 'RESERVED_SEATING',
      capacity: 4,
      lots: [],
      rows: [{ label: 'A', seatCount: 4 }],
    },
  ],
};

const AVAILABILITY: ShowAvailability = {
  showId: 's1',
  sectors: ['pista', 'plateia'].map((id) => ({
    id,
    name: id,
    kind: id === 'pista' ? ('GENERAL_ADMISSION' as const) : ('RESERVED_SEATING' as const),
    capacity: 10,
    sale: 'ON_SALE' as const,
    lot: { id: `${id}-lot`, name: '2º lote', priceCents: 12_000 },
    available: 4,
  })),
};

describe('CheckoutPage', () => {
  let http: HttpTestingController;

  async function render(sectorId: string) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: SseClient, useValue: { connect: () => NEVER } },
        { provide: AuthService, useValue: { login: vi.fn(), accessToken: () => of('') } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(CheckoutPage);
    fixture.componentRef.setInput('id', 's1');
    fixture.componentRef.setInput('sectorId', sectorId);
    fixture.detectChanges();
    http.expectOne('/api/v1/shows/s1').flush(SHOW);
    http.expectOne('/api/v1/availability/s1').flush(AVAILABILITY);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const text = () => element.textContent!.replace(/\s+/g, ' ');
    return { fixture, element, text, navigate };
  }

  it('na pista, soma o preço do lote em venda pela quantidade e reserva com o CPF', async () => {
    const { fixture, element, text, navigate } = await render('pista');
    expect(text()).toContain('Pista');
    expect(text()).toContain('2º lote');

    element.querySelector<HTMLButtonElement>('[aria-label="Mais um ingresso"]')!.click();
    await fixture.whenStable();
    expect(element.querySelector('output')!.textContent).toBe('2');
    expect(element.querySelector('.total dd')!.textContent).toContain('240,00');

    const input = element.querySelector<HTMLInputElement>('input[formcontrolname="cpf"]')!;
    input.value = '52998224725';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();
    expect(input.value).toBe('529.982.247-25');

    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    const request = http.expectOne('/api/v1/reservations');
    expect(request.request.body).toMatchObject({ quantity: 2, cpf: '52998224725' });
    request.flush({ id: 'r1' }, { status: 201, statusText: 'Created' });
    expect(navigate).toHaveBeenCalledWith(['/reservas', 'r1']);
  });

  it('não reserva com CPF inválido', async () => {
    const { fixture, element, text } = await render('pista');
    const input = element.querySelector<HTMLInputElement>('input[formcontrolname="cpf"]')!;
    input.value = '52998224724';
    input.dispatchEvent(new Event('input'));
    element.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await fixture.whenStable();

    http.expectNone('/api/v1/reservations');
    expect(text()).toContain('CPF inválido');
  });

  it('na cadeira numerada, mostra o mapa e as cadeiras escolhidas', async () => {
    const { fixture, element, text } = await render('plateia');
    http.expectOne('/api/v1/availability/s1/sectors/plateia/seats').flush({
      showId: 's1',
      sectorId: 'plateia',
      seats: ['A-1', 'A-2', 'A-3', 'A-4'].map((label) => ({ label, available: label !== 'A-4' })),
    });
    await fixture.whenStable();
    expect(element.querySelectorAll('[role="gridcell"]').length).toBe(4);

    element.querySelector<SVGElement>('[data-seat="A-2"]')!.dispatchEvent(new MouseEvent('click'));
    element.querySelector<SVGElement>('[data-seat="A-4"]')!.dispatchEvent(new MouseEvent('click'));
    await fixture.whenStable();
    expect(element.querySelector('dl dd')!.textContent!.trim()).toBe('A-2');
    expect(text()).toContain('A cadeira A-4 não está livre.');
    expect(element.querySelector('.total dd')!.textContent).toContain('120,00');
  });
});

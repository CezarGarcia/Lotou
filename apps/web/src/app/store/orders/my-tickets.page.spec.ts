import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { OrderStatus, OrderSummary } from '../data/sale.models';
import { MyTicketsPage } from './my-tickets.page';

const order = (id: string, showId: string, status: OrderStatus = 'CONFIRMED'): OrderSummary => ({
  id,
  status,
  showId,
  totalCents: 10_000,
  tickets: 2,
  createdAt: '2026-01-01T00:00:00Z',
});

const show = (id: string, artist: string, startsAt: string) => ({
  id,
  artist,
  title: 'Turnê',
  startsAt,
  venue: { id: 'v1', name: 'Arena', city: 'Recife', state: 'PE', timezone: 'America/Recife' },
  sectors: [],
});

const DAY = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

describe('MyTicketsPage', () => {
  async function render(orders: OrderSummary[], shows: ReturnType<typeof show>[]) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(MyTicketsPage);
    fixture.detectChanges();
    http
      .expectOne((req) => req.url === '/api/v1/orders')
      .flush({ items: orders, nextCursor: null });
    for (const item of shows) {
      http.expectOne(`/api/v1/shows/${item.id}`).flush(item);
    }
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const names = (element: HTMLElement, group: string) =>
    [...element.querySelectorAll(`[aria-labelledby="${group}"] .info strong`)].map((name) =>
      name.textContent!.trim(),
    );

  it('separa os próximos shows (do mais perto ao mais longe) dos passados e cancelados', async () => {
    const element = await render(
      [
        order('o1', 'longe'),
        order('o2', 'perto'),
        order('o3', 'passado'),
        order('o4', 'perto', 'REFUNDED'),
      ],
      [
        show('longe', 'Banda Longe', inDays(40)),
        show('perto', 'Banda Perto', inDays(3)),
        show('passado', 'Banda Antiga', inDays(-10)),
      ],
    );
    expect(names(element, 'proximos')).toEqual(['Banda Perto', 'Banda Longe']);
    expect(names(element, 'passados')).toEqual(['Banda Antiga', 'Banda Perto']);
    expect(element.querySelectorAll('[aria-labelledby="proximos"] app-cartaz').length).toBe(2);
  });

  it('convida a ver os shows quando ainda não há ingressos', async () => {
    const element = await render([], []);
    expect(element.textContent).toContain('Nenhum ingresso por aqui ainda');
    expect(element.querySelector('a[href="/"]')!.textContent).toContain('Ver os shows');
  });
});

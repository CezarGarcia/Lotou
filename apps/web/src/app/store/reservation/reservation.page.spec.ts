import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { Reservation } from '../data/sale.models';
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

describe('ReservationPage', () => {
  async function render(value: Reservation) {
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
    const element = fixture.nativeElement as HTMLElement;
    return { element, text: () => element.textContent!.replace(/\s+/g, ' ') };
  }

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

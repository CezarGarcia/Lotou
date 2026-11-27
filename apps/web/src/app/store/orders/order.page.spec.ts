import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Order } from '../data/sale.models';
import { OrderPage } from './order.page';

const order = (value: Partial<Order>): Order => ({
  id: 'o1',
  status: 'CONFIRMED',
  showId: 's1',
  reservationId: 'r1',
  totalCents: 24_000,
  cancelReason: null,
  createdAt: '2031-01-01T00:00:00Z',
  confirmedAt: '2031-01-01T00:00:05Z',
  items: [{ sectorName: 'Plateia', lotName: '1º lote', seat: 'A-1', unitPriceCents: 12_000 }],
  tickets: [],
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

describe('OrderPage', () => {
  async function render(value: Order) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(OrderPage);
    fixture.componentRef.setInput('id', 'o1');
    fixture.detectChanges();
    http.expectOne('/api/v1/orders/o1').flush(value);
    await settle(fixture);
    http.expectOne('/api/v1/shows/s1').flush(SHOW);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    return { element, fixture, text: () => element.textContent!.replace(/\s+/g, ' ') };
  }

  it('lista os ingressos do pedido confirmado, cada um com o seu QR code', async () => {
    const { element, text, fixture } = await render(
      order({
        tickets: [
          {
            id: 't-1',
            status: 'VALID',
            sectorName: 'Plateia',
            seat: 'A-1',
            issuedAt: '',
            code: 'LOTOU1.t-1.assinatura',
          },
          {
            id: 't-2',
            status: 'USED',
            sectorName: 'Plateia',
            seat: 'A-2',
            issuedAt: '',
            code: 'LOTOU1.t-2.assinatura',
          },
        ],
      }),
    );
    await fixture.whenStable();
    fixture.detectChanges();

    expect(text()).toContain('Compra confirmada!');
    expect(element.querySelectorAll('.ticket').length).toBe(2);
    expect(text()).toContain('Cadeira A-1');
    expect(element.querySelector('.ticket code')!.textContent).toBe('t-1');
    expect(text()).toContain('Utilizado');
    expect(text()).toContain('R$');
    const qrs = element.querySelectorAll('.ticket svg[role="img"]');
    expect(qrs.length).toBe(2);
    expect(qrs[0].getAttribute('aria-label')).toBe('QR code do ingresso, Plateia, Cadeira A-1');
    expect(text()).not.toContain('próxima versão');
  });

  it('ingresso emitido antes do código assinado mostra "QR indisponível"; cancelado não tem QR', async () => {
    const { element, text } = await render(
      order({
        tickets: [
          { id: 't-1', status: 'VALID', sectorName: 'Pista', seat: null, issuedAt: '' },
          {
            id: 't-2',
            status: 'CANCELLED',
            sectorName: 'Pista',
            seat: null,
            issuedAt: '',
            code: 'LOTOU1.t-2.assinatura',
          },
        ],
      }),
    );
    expect(element.querySelectorAll('app-ticket-qr').length).toBe(1);
    expect(text()).toContain('QR indisponível');
    expect(text()).toContain('Cancelado');
  });

  it('explica em palavras simples por que o pedido foi cancelado', async () => {
    const { text } = await render(
      order({ status: 'CANCELLED', cancelReason: 'PAYMENT_DECLINED', confirmedAt: null }),
    );
    expect(text()).toContain('Pedido cancelado');
    expect(text()).toContain('O pagamento foi recusado. Nada foi cobrado');
  });

  it('mostra a espera enquanto o pagamento é processado', async () => {
    const { text } = await render(order({ status: 'PENDING', confirmedAt: null }));
    expect(text()).toContain('Confirmando o pagamento...');
  });
});

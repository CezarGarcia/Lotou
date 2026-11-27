import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
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

const plain = (text: string) => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ');

describe('OrderPage', () => {
  let dialogAnswer: boolean | undefined;
  let dialogData: unknown;

  async function render(value: Order, show: object = SHOW) {
    dialogAnswer = undefined;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: MatDialog,
          useValue: {
            open: (_component: unknown, config: { data: unknown }) => {
              dialogData = config.data;
              return { afterClosed: () => of(dialogAnswer) };
            },
          },
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(OrderPage);
    fixture.componentRef.setInput('id', 'o1');
    fixture.detectChanges();
    http.expectOne('/api/v1/orders/o1').flush(value);
    await settle(fixture);
    http.expectOne('/api/v1/shows/s1').flush(show);
    await settle(fixture);
    const element = fixture.nativeElement as HTMLElement;
    return { element, fixture, http, text: () => plain(element.textContent!) };
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
            // 20:31 em Recife (UTC-3).
            usedAt: '2031-01-01T23:31:00Z',
            gate: 'Portão B',
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
    // O ingresso usado mostra a entrada, no fuso do show, em vez do QR.
    const qrs = element.querySelectorAll('.ticket svg[role="img"]');
    expect(qrs.length).toBe(1);
    expect(qrs[0].getAttribute('aria-label')).toBe('QR code do ingresso, Plateia, Cadeira A-1');
    const stamp = plain(element.querySelector('.stamp.used')!.textContent!);
    expect(stamp).toContain('Entrada registrada');
    expect(stamp).toContain('01/01/2031 às 20:31');
    expect(stamp).toContain('Portão B');
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

  it('conta quantos dias faltam para o show na confirmação', async () => {
    const startsAt = new Date(Date.now() + 20 * 86_400_000).toISOString();
    const { text } = await render(order({}), { ...SHOW, startsAt });
    expect(text()).toContain('Faltam 20 dias para o show.');
  });

  it('mostra a espera enquanto o pagamento é processado', async () => {
    const { text } = await render(order({ status: 'PENDING', confirmedAt: null }));
    expect(text()).toContain('Confirmando o pagamento...');
  });

  it('detalha desconto e taxa no resumo', async () => {
    const { element } = await render(
      order({
        subtotalCents: 24_000,
        discountCents: 2_400,
        couponCode: 'AMIGOS10',
        serviceFeeCents: 2_400,
        serviceFeePaidBy: 'BUYER',
        totalCents: 24_000,
      }),
    );
    const rows = [...element.querySelectorAll('.items li')].map(
      (row) =>
        `${plain(row.querySelector('span')!.textContent!).trim()} = ${plain(row.querySelector('strong')!.textContent!)}`,
    );
    expect(rows).toContain('Desconto (cupom AMIGOS10) = − R$ 24,00');
    expect(rows).toContain('Taxa de serviço = R$ 24,00');
  });

  it('não mostra taxa quando o produtor a absorve', async () => {
    const { text } = await render(
      order({ serviceFeeCents: 2_400, serviceFeePaidBy: 'PRODUCER', discountCents: 0 }),
    );
    expect(text()).not.toContain('Taxa de serviço');
  });

  describe('cancelamento', () => {
    const allowed = order({
      totalCents: 26_400,
      cancellation: { allowed: true, reason: null, deadline: '2031-01-08T02:59:00Z' },
    });

    const cancelButton = (element: HTMLElement) =>
      [...element.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent!.includes('Cancelar pedido'),
      );

    it('oferece o cancelamento dentro do prazo, com a data no fuso do show', async () => {
      const { element, text } = await render(allowed);
      expect(text()).toContain('Você pode cancelar este pedido até 07/01/2031 às 23:59');
      expect(text()).toContain('receber de volta R$ 264,00, taxa de serviço incluída');
      expect(cancelButton(element)).toBeDefined();
    });

    it('só cancela depois da confirmação no diálogo', async () => {
      const { element, http, fixture, text } = await render(allowed);
      dialogAnswer = false;
      cancelButton(element)!.click();
      http.expectNone('/api/v1/orders/o1/cancel');
      expect(dialogData).toMatchObject({ totalCents: 26_400, tickets: 1 });

      dialogAnswer = true;
      cancelButton(element)!.click();
      const request = http.expectOne('/api/v1/orders/o1/cancel');
      expect(request.request.method).toBe('POST');
      request.flush({ ...allowed, status: 'REFUNDING' }, { status: 202, statusText: 'Accepted' });
      await settle(fixture);
      expect(text()).toContain('Reembolso em andamento');
      expect(text()).toContain('Estamos devolvendo R$ 264,00');
      expect(cancelButton(element)).toBeUndefined();
    });

    it('mostra o motivo quando o servidor recusa o cancelamento', async () => {
      const { element, http, fixture, text } = await render(allowed);
      dialogAnswer = true;
      cancelButton(element)!.click();
      http.expectOne('/api/v1/orders/o1/cancel').flush(
        {
          type: 'urn:lotou:problem:cancellation-not-allowed',
          title: 'Cancelamento não permitido',
          status: 409,
          reason: 'TOO_CLOSE_TO_SHOW',
        },
        { status: 409, statusText: 'Conflict' },
      );
      await settle(fixture);
      expect(element.querySelector('.cancellation [role="alert"]')!.textContent).toContain(
        'Faltam menos de 48 horas',
      );
      // Relê o pedido, que agora diz que não pode.
      http
        .expectOne('/api/v1/orders/o1')
        .flush(
          order({ cancellation: { allowed: false, reason: 'TOO_CLOSE_TO_SHOW', deadline: null } }),
        );
      await settle(fixture);
      expect(cancelButton(element)).toBeUndefined();
      expect(text()).toContain('Faltam menos de 48 horas para o show');
    });

    it.each([
      ['WINDOW_EXPIRED', 'até 7 dias depois da compra'],
      ['TOO_CLOSE_TO_SHOW', 'Faltam menos de 48 horas'],
      ['TICKET_USED', 'já foi usado na entrada'],
      ['ALGO_NOVO', 'Este pedido não pode ser cancelado.'],
    ])('explica por que não pode cancelar (%s)', async (reason, message) => {
      const { element, text } = await render(
        order({ cancellation: { allowed: false, reason, deadline: null } }),
      );
      expect(cancelButton(element)).toBeUndefined();
      expect(text()).toContain(message);
    });

    it('mostra o reembolso concluído, com valor e data', async () => {
      const { text } = await render(
        order({
          status: 'REFUNDED',
          totalCents: 26_400,
          refundedCents: 26_400,
          refundedAt: '2031-01-02T15:00:00Z',
        }),
      );
      expect(text()).toContain('Pedido reembolsado');
      expect(text()).toContain(
        'Devolvemos R$ 264,00, taxa de serviço incluída, em 02/01/2031 às 12:00.',
      );
    });

    it('diz quando o reembolso veio do cancelamento do show', async () => {
      const { text } = await render(order({ status: 'REFUNDING' }), {
        ...SHOW,
        status: 'CANCELLED',
      });
      expect(text()).toContain('O show foi cancelado pelo produtor.');
    });

    it('avisa que vamos entrar em contato quando o reembolso falha', async () => {
      const { text } = await render(order({ status: 'REFUND_FAILED' }));
      expect(text()).toContain('Seu reembolso está atrasado');
      expect(text()).toContain('entrar em contato com você');
    });
  });
});

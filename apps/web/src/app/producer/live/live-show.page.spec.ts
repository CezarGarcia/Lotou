import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Subject, of } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { LIVE_CLIENT_OPTIONS, WEB_SOCKET_FACTORY } from './live-dashboard.client';
import { LiveShowPage } from './live-show.page';
import { ANNOUNCE_EVERY_MS } from './live-show.store';
import { ProducerShowContext } from '../show/show-context';
import { FakeWebSocket, confirmedEntry, liveMetrics } from './live.testing';

/** O documento do show no catálogo: o local fica em Manaus (UTC-4). */
const SHOW = {
  id: 's1',
  title: 'Turnê Mar Aberto',
  artist: 'Banda do Mar',
  status: 'ON_SALE',
  startsAt: '2031-01-01T01:00:00.000Z',
  salesStartAt: null,
  highDemand: false,
  venue: { id: 'v1', name: 'Arena', city: 'Manaus', state: 'AM', timezone: 'America/Manaus' },
  priceFromCents: 10_000,
  description: '',
  doorsOpenAt: null,
  salesEndAt: null,
  sectors: [],
};

const plain = (text: string) => text.replace(/ /g, ' ').replace(/\s+/g, ' ');

describe('LiveShowPage', () => {
  let sockets: FakeWebSocket[];
  let fixture: ComponentFixture<LiveShowPage>;
  let http: HttpTestingController;
  const login = vi.fn();

  const socket = () => sockets[sockets.length - 1];
  const element = () => fixture.nativeElement as HTMLElement;
  const text = () => plain(element().textContent!);

  async function tick(ms = 0) {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
  }

  async function render() {
    vi.useFakeTimers({ now: Date.parse('2026-11-26T18:00:10Z') });
    sockets = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {
            accessToken: () => of('token-1'),
            tokenRenewed: () => new Subject<string>(),
            refreshSession: () => of(''),
            login,
          },
        },
        {
          provide: WEB_SOCKET_FACTORY,
          useValue: (url: string) => {
            const created = new FakeWebSocket(url);
            sockets.push(created);
            return created;
          },
        },
        { provide: LIVE_CLIENT_OPTIONS, useValue: { url: 'ws://teste/live', random: () => 1 } },
        // A moldura das abas fornece o show; aqui o teste faz esse papel.
        ProducerShowContext,
      ],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(ProducerShowContext).id.set('s1');
    fixture = TestBed.createComponent(LiveShowPage);
    fixture.detectChanges();
    await tick();
    http.expectOne('/api/v1/shows/s1').flush(SHOW);
    await tick();
  }

  async function goLive() {
    socket().open();
    await tick();
    socket().receive({ type: 'ready', user: 'produtor' });
    await tick();
  }

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('assina o show e mostra "Conectando..." até o servidor aceitar', async () => {
    await render();
    expect(text()).toContain('Conectando...');
    expect(element().querySelector('[aria-busy="true"]')).not.toBeNull();

    await goLive();
    expect(socket().sentOf('subscribe')).toEqual([{ type: 'subscribe', showId: 's1' }]);
    expect(text()).toContain('Ao vivo');
  });

  it('mostra os números, os setores e o feed da foto', async () => {
    await render();
    await goLive();
    socket().receive({
      type: 'snapshot',
      showId: 's1',
      metrics: liveMetrics(),
      activity: [
        confirmedEntry(9),
        { ...confirmedEntry(5), type: 'LotOpened', lotName: '2º lote', priceCents: 15_000 },
      ],
    });
    await tick();

    const kpis = [...element().querySelectorAll('.kpi')].map((kpi) => [
      plain(kpi.querySelector('dt')!.textContent!).trim(),
      plain(kpi.querySelector('dd')!.textContent!).trim(),
    ]);
    expect(kpis).toEqual([
      ['Ingressos vendidos', '1.240 de 2.100'],
      ['Receita', 'R$ 186.000,00'],
      ['Ingressos restantes', '860'],
      ['Pedidos confirmados', '610'],
      ['Pedidos cancelados', '42'],
      ['Pedidos no último minuto', '37'],
    ]);

    const sectors = element().querySelectorAll('app-sector-card');
    expect(sectors).toHaveLength(2);
    expect(plain(sectors[0].textContent!)).toContain('1.180 de 2.000 vendidos · 59%');
    expect(plain(sectors[0].textContent!)).toContain('820 restantes');
    expect(plain(sectors[0].textContent!)).toContain('2º lote · R$ 150,00');
    expect(plain(sectors[0].textContent!)).toContain('Em venda');
    const meter = sectors[0].querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('1180');
    expect(meter.getAttribute('aria-valuetext')).toBe('1.180 de 2.000 vendidos (59%)');
    expect(plain(sectors[1].textContent!)).toContain('As vendas ainda não abriram');

    const entries = element().querySelectorAll('app-activity-feed li');
    expect(entries).toHaveLength(2);
    expect(plain(entries[0].textContent!)).toContain('Pedido confirmado');
    expect(plain(entries[0].textContent!)).toContain('2 ingressos em Pista · R$ 300,00');
    expect(plain(entries[0].textContent!)).toContain('agora');
    expect(plain(entries[1].textContent!)).toContain('Lote aberto');
    // O horário completo fica no fuso do show: 18h UTC são 14h em Manaus.
    expect(entries[0].querySelector('time')!.getAttribute('title')).toBe('26/11/2026 às 14:00');
    expect(text()).toContain('atualizado agora');
  });

  it('atualiza com as métricas e conta o tempo desde a última atualização', async () => {
    await render();
    await goLive();
    socket().receive({ type: 'snapshot', showId: 's1', metrics: liveMetrics(), activity: [] });
    await tick();
    socket().receive({
      type: 'metrics',
      showId: 's1',
      metrics: liveMetrics({ at: '2026-11-26T18:00:02Z', ticketsSold: 1242 }),
    });
    await tick();
    expect(text()).toContain('1.242');

    await tick(5_000);
    expect(text()).toContain('atualizado há 5 s');
  });

  it('anuncia a atividade nova aos leitores de tela, no máximo uma vez a cada 10 s', async () => {
    await render();
    await goLive();
    socket().receive({ type: 'snapshot', showId: 's1', metrics: liveMetrics(), activity: [] });
    await tick();
    const live = () => plain(element().querySelector('[aria-live="polite"]')!.textContent!).trim();
    expect(live()).toBe('');

    socket().receive({ type: 'activity', showId: 's1', entry: confirmedEntry(11) });
    await tick();
    expect(live()).toBe('Pedido confirmado: 2 ingressos em Pista, R$ 300,00.');

    socket().receive({ type: 'activity', showId: 's1', entry: confirmedEntry(12) });
    socket().receive({ type: 'activity', showId: 's1', entry: confirmedEntry(13) });
    await tick(1_000);
    expect(live()).toBe('Pedido confirmado: 2 ingressos em Pista, R$ 300,00.');

    await tick(ANNOUNCE_EVERY_MS);
    expect(live()).toBe(
      '2 novas atividades. A mais recente: Pedido confirmado: 2 ingressos em Pista, R$ 300,00.',
    );
    expect(element().querySelectorAll('app-activity-feed li')).toHaveLength(3);
  });

  it('mostra "Reconectando..." com o botão para tentar já', async () => {
    await render();
    await goLive();
    socket().serverClose(1006);
    await tick();
    expect(text()).toContain('Reconectando...');

    const retry = [...element().querySelectorAll('button')].find((button) =>
      button.textContent!.includes('Tentar agora'),
    )!;
    retry.click();
    await tick();
    expect(sockets).toHaveLength(2);
  });

  it('mostra as entradas na portaria e os reembolsos quando o analytics manda', async () => {
    await render();
    await goLive();
    socket().receive({
      type: 'snapshot',
      showId: 's1',
      metrics: {
        ...liveMetrics(),
        checkedIn: 310,
        checkinsByGate: [
          { gate: 'Portão A', count: 200 },
          { gate: 'Portão B', count: 110 },
        ],
        ordersRefunded: 3,
      },
      activity: [
        {
          id: '1764180009000-0',
          eventId: 'e9',
          type: 'TicketCheckedIn',
          at: '2026-11-26T18:00:09Z',
          sectorName: 'Pista',
          gate: 'Portão B',
        },
        {
          id: '1764180008000-0',
          eventId: 'e8',
          type: 'OrderRefunded',
          at: '2026-11-26T18:00:08Z',
          orderId: 'o8',
          refundedCents: 33_000,
          reason: 'ORDER_CANCELLED',
        },
      ],
    });
    await tick();

    const gates = element().querySelector('.gates')!;
    expect(plain(gates.textContent!)).toContain('310 entradas de 1.240 ingressos vendidos');
    const meter = gates.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuetext')).toBe('310 de 1.240 já entraram (25%)');
    const byGate = [...gates.querySelectorAll('li')].map(
      (li) =>
        `${li.querySelector('span')!.textContent}: ${li.querySelector('strong')!.textContent}`,
    );
    expect(byGate).toEqual(['Portão A: 200', 'Portão B: 110']);
    expect(text()).toContain('Pedidos reembolsados');

    const entries = element().querySelectorAll('app-activity-feed li');
    expect(plain(entries[0].textContent!)).toContain('Entrada na portaria');
    expect(plain(entries[0].textContent!)).toContain('Pista · Portão B');
    expect(plain(entries[1].textContent!)).toContain('Pedido reembolsado');
    expect(plain(entries[1].textContent!)).toContain('cancelado pelo comprador · R$ 330,00');
  });

  it('sem os números da portaria, não inventa nada', async () => {
    await render();
    await goLive();
    socket().receive({ type: 'snapshot', showId: 's1', metrics: liveMetrics(), activity: [] });
    await tick();
    expect(element().querySelector('.gates')).toBeNull();
    expect(text()).not.toContain('Pedidos reembolsados');
  });

  it('show de outro produtor: avisa sem mostrar dados', async () => {
    await render();
    await goLive();
    socket().receive({ type: 'error', code: 'forbidden', detail: 'Show', showId: 's1' });
    await tick();
    expect(text()).toContain('Show indisponível no painel');
  });

  it('sessão expirada: oferece entrar de novo', async () => {
    await render();
    await goLive();
    socket().serverClose(4401);
    await tick();
    expect(text()).toContain('Sua sessão expirou');

    element().querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    expect(login).toHaveBeenCalled();
  });

  it('sem o papel de produtor: acesso restrito', async () => {
    await render();
    socket().open();
    await tick();
    socket().serverClose(4403);
    await tick();
    expect(text()).toContain('Sua conta não tem acesso ao painel ao vivo.');
  });

  it('sair da tela cancela a assinatura', async () => {
    await render();
    await goLive();
    fixture.destroy();
    expect(socket().sentOf('unsubscribe')).toEqual([{ type: 'unsubscribe', showId: 's1' }]);
  });
});

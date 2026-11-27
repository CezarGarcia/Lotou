import { TestBed } from '@angular/core/testing';
import { Observable, Subject, Subscription, of } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import {
  LIVE_CLIENT_OPTIONS,
  LiveClientOptions,
  LiveDashboardClient,
  LiveShowEvent,
  WEB_SOCKET_FACTORY,
  backoffDelay,
} from './live-dashboard.client';
import { FakeWebSocket, confirmedEntry, liveMetrics } from './live.testing';

const URL = 'ws://loja.teste/api/v1/analytics/live';

const OPTIONS: Partial<LiveClientOptions> = {
  url: URL,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
  stableAfterMs: 10_000,
  staleAfterMs: 15_000,
  idleCloseMs: 10_000,
  // Jitter no máximo: as esperas ficam exatamente 1 s, 2 s, 4 s...
  random: () => 1,
};

/** Deixa as promessas pendentes (a leitura do token) terminarem. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('backoffDelay', () => {
  const base = { backoffBaseMs: 1_000, backoffMaxMs: 30_000 };

  it('dobra a cada tentativa, até o teto', () => {
    const full = { ...base, random: () => 1 };
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, full))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('sorteia entre a metade e o total da espera', () => {
    expect(backoffDelay(2, { ...base, random: () => 0 })).toBe(2_000);
    expect(backoffDelay(2, { ...base, random: () => 0.5 })).toBe(3_000);
    expect(backoffDelay(10, { ...base, random: () => 0 })).toBe(15_000);
  });
});

describe('LiveDashboardClient', () => {
  let sockets: FakeWebSocket[];
  let token: string;
  let renewed: Subject<string>;
  let refreshSession: ReturnType<typeof vi.fn<() => Observable<string>>>;
  let client: LiveDashboardClient;
  let subscriptions: Subscription;

  const last = () => sockets[sockets.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    token = 'token-1';
    renewed = new Subject<string>();
    refreshSession = vi.fn(() => of('token-2'));
    subscriptions = new Subscription();
    TestBed.configureTestingModule({
      providers: [
        {
          provide: AuthService,
          useValue: {
            accessToken: () => of(token),
            tokenRenewed: () => renewed,
            refreshSession,
          },
        },
        {
          provide: WEB_SOCKET_FACTORY,
          useValue: (url: string) => {
            const socket = new FakeWebSocket(url);
            sockets.push(socket);
            return socket;
          },
        },
        { provide: LIVE_CLIENT_OPTIONS, useValue: OPTIONS },
      ],
    });
    client = TestBed.inject(LiveDashboardClient);
  });

  afterEach(() => {
    subscriptions.unsubscribe();
    vi.useRealTimers();
  });

  /** Assina um show e guarda o que chega. */
  function watch(showId: string) {
    const events: LiveShowEvent[] = [];
    const subscription = client.watch(showId).subscribe((event) => events.push(event));
    subscriptions.add(subscription);
    return { events, subscription };
  }

  /** Abre a conexão do lado do servidor e aceita o token. */
  async function accept(socket = last()) {
    socket.open();
    await flush();
    socket.receive({ type: 'ready', user: 'produtor-1' });
  }

  it('abre a conexão só quando a tela assina um show', () => {
    expect(sockets).toHaveLength(0);
    expect(client.status()).toBe('idle');

    watch('show-1');

    expect(sockets).toHaveLength(1);
    expect(last().url).toBe(URL);
    expect(client.status()).toBe('connecting');
  });

  it('manda o token na primeira mensagem e só assina depois do ready', async () => {
    watch('show-1');
    last().open();
    await flush();

    expect(last().sent).toEqual([{ type: 'auth', token: 'token-1' }]);
    expect(client.status()).toBe('connecting');

    last().receive({ type: 'ready', user: 'produtor-1' });

    expect(last().sent).toEqual([
      { type: 'auth', token: 'token-1' },
      { type: 'subscribe', showId: 'show-1' },
    ]);
    expect(client.status()).toBe('live');
  });

  it('nunca põe o token na URL', () => {
    watch('show-1');
    expect(last().url).not.toContain('token');
  });

  it('entrega a foto, as métricas e a atividade só ao show certo', async () => {
    const one = watch('show-1');
    const two = watch('show-2');
    await accept();
    expect(last().sentOf('subscribe')).toEqual([
      { type: 'subscribe', showId: 'show-1' },
      { type: 'subscribe', showId: 'show-2' },
    ]);

    const metrics = liveMetrics();
    const entry = confirmedEntry(1);
    last().receive({ type: 'snapshot', showId: 'show-1', metrics, activity: [entry] });
    last().receive({ type: 'metrics', showId: 'show-1', metrics });
    last().receive({ type: 'activity', showId: 'show-2', entry });

    expect(one.events).toEqual([
      { type: 'snapshot', metrics, activity: [entry] },
      { type: 'metrics', metrics },
    ]);
    expect(two.events).toEqual([{ type: 'activity', entry }]);
  });

  it('ignora frames malformados sem derrubar a conexão', async () => {
    const { events } = watch('show-1');
    await accept();

    last().receive('isto não é JSON');
    last().receive(new ArrayBuffer(8));
    last().receive([1, 2, 3]);
    last().receive({ type: 'tipo-novo', showId: 'show-1' });
    last().receive({ type: 'metrics', showId: 'show-1', metrics: { ticketsSold: 'muitos' } });
    last().receive({
      type: 'metrics',
      showId: 'show-1',
      metrics: liveMetrics({ revenueCents: 1.5 }),
    });
    last().receive({ type: 'activity', showId: 'show-1', entry: { id: '1-0', type: 'CheckIn' } });
    last().receive({ type: 'snapshot', showId: 'show-1' });

    expect(events).toEqual([]);
    expect(client.status()).toBe('live');
    expect(last().closedByClient).toBeNull();

    last().receive({ type: 'metrics', showId: 'show-1', metrics: liveMetrics() });
    expect(events).toHaveLength(1);
  });

  it('aceita virada de lote com setor e lote nulos', async () => {
    const { events } = watch('show-1');
    await accept();
    const entry = {
      id: '5-0',
      eventId: 'e',
      type: 'LotSoldOut',
      at: '2026-11-26T18:00:00Z',
      sectorName: null,
      lotName: null,
    };
    last().receive({ type: 'activity', showId: 'show-1', entry });
    last().receive({
      type: 'activity',
      showId: 'show-1',
      entry: { ...entry, id: '6-0', lotName: 7 },
    });
    expect(events).toEqual([{ type: 'activity', entry }]);
  });

  it('descarta da foto só as entradas de tipo desconhecido', async () => {
    const { events } = watch('show-1');
    await accept();
    const entry = confirmedEntry(1);
    last().receive({
      type: 'snapshot',
      showId: 'show-1',
      metrics: liveMetrics(),
      activity: [{ id: '9-0', type: 'CheckIn', at: entry.at }, entry],
    });
    expect(events).toEqual([{ type: 'snapshot', metrics: liveMetrics(), activity: [entry] }]);
  });

  it('autentica de novo quando o token é renovado, na mesma conexão', async () => {
    watch('show-1');
    await accept();

    renewed.next('token-2');
    renewed.next('token-2');

    expect(sockets).toHaveLength(1);
    expect(last().sentOf('auth')).toEqual([
      { type: 'auth', token: 'token-1' },
      { type: 'auth', token: 'token-2' },
    ]);
  });

  it('o ready que confirma a renovação não repete as assinaturas', async () => {
    const { events } = watch('show-1');
    await accept();
    renewed.next('token-2');
    last().receive({ type: 'ready', user: 'produtor-1' });

    expect(last().sentOf('subscribe')).toHaveLength(1);
    expect(client.status()).toBe('live');
    last().receive({ type: 'metrics', showId: 'show-1', metrics: liveMetrics() });
    expect(events).toHaveLength(1);
  });

  it('renovação recusada (4401, token de outro usuário) renova a sessão e reconecta', async () => {
    watch('show-1');
    await accept();
    renewed.next('token-de-outro');
    last().serverClose(4401);
    await flush();

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
  });

  it('não manda token renovado antes de a conexão abrir', () => {
    watch('show-1');
    renewed.next('token-2');
    expect(last().sent).toEqual([]);
  });

  it('cancelar manda unsubscribe e fecha a conexão ociosa depois de um tempo', async () => {
    const { subscription } = watch('show-1');
    await accept();

    subscription.unsubscribe();
    expect(last().sentOf('unsubscribe')).toEqual([{ type: 'unsubscribe', showId: 'show-1' }]);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(last().closedByClient).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(last().closedByClient).toBe(1000);
    expect(client.status()).toBe('idle');
  });

  it('voltar a um show logo depois reaproveita a conexão aberta', async () => {
    const first = watch('show-1');
    await accept();
    first.subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(5_000);

    watch('show-2');
    // Já passou o tempo de fechar a conexão ociosa, contado do primeiro cancelamento.
    await vi.advanceTimersByTimeAsync(6_000);

    expect(sockets).toHaveLength(1);
    expect(last().closedByClient).toBeNull();
    expect(last().sentOf('subscribe').at(-1)).toEqual({ type: 'subscribe', showId: 'show-2' });
  });

  it('reconecta com espera exponencial e assina os mesmos shows de novo', async () => {
    const { events } = watch('show-1');
    await accept();

    last().serverClose(1006);
    expect(client.status()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);

    // A nova tentativa também falha (servidor fora do ar): agora espera 2 s.
    last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    expect(client.status()).toBe('reconnecting');

    await accept();
    expect(client.status()).toBe('live');
    expect(last().sent).toEqual([
      { type: 'auth', token: 'token-1' },
      { type: 'subscribe', showId: 'show-1' },
    ]);

    last().receive({ type: 'snapshot', showId: 'show-1', metrics: liveMetrics(), activity: [] });
    expect(events.at(-1)?.type).toBe('snapshot');
  });

  it('volta à espera curta depois de uma conexão estável', async () => {
    watch('show-1');
    await accept();
    last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    await accept();

    // Ficou de pé o bastante: a próxima queda espera 1 s, não 2 s.
    await vi.advanceTimersByTimeAsync(10_000);
    last().serverClose(1012);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(3);
  });

  it('conexão que cai logo depois do ready continua aumentando a espera', async () => {
    watch('show-1');
    await accept();
    last().serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    await accept();
    last().serverClose(1006);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
  });

  it('4408 (autenticação atrasada) reconecta como uma queda comum', async () => {
    watch('show-1');
    last().open();
    last().serverClose(4408);
    expect(client.status()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('1013 (cliente lento ou falha temporária): reconecta com espera e assina de novo', async () => {
    watch('show-1');
    await accept();
    last().serverClose(1013);
    expect(client.status()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    await accept();
    expect(last().sentOf('subscribe')).toEqual([{ type: 'subscribe', showId: 'show-1' }]);
  });

  it('4401: renova a sessão e reconecta na hora com o token novo', async () => {
    watch('show-1');
    await accept();

    token = 'token-2';
    last().serverClose(4401);
    await flush();

    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    await accept();
    expect(last().sentOf('auth')).toEqual([{ type: 'auth', token: 'token-2' }]);
    expect(client.status()).toBe('live');
  });

  it('4401 de novo depois da renovação: a sessão expirou', async () => {
    watch('show-1');
    await accept();
    last().serverClose(4401);
    await flush();
    last().open();
    await flush();
    last().serverClose(4401);
    await flush();

    expect(client.status()).toBe('denied');
    expect(client.denial()).toBe('session-expired');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
  });

  it('4401 e a renovação falha: a sessão expirou', async () => {
    refreshSession.mockReturnValue(of(''));
    watch('show-1');
    await accept();
    last().serverClose(4401);
    await flush();

    expect(client.denial()).toBe('session-expired');
    expect(sockets).toHaveLength(1);
  });

  it('4403: sem o papel de produtor, não tenta de novo', async () => {
    watch('show-1');
    last().open();
    await flush();
    last().serverClose(4403);

    expect(client.status()).toBe('denied');
    expect(client.denial()).toBe('not-producer');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);

    // Outra tela que assine um show também não reabre a conexão.
    watch('show-2');
    expect(sockets).toHaveLength(1);
  });

  it('sem token, nem tenta: a sessão expirou', async () => {
    token = '';
    watch('show-1');
    last().open();
    await flush();

    expect(last().sent).toEqual([]);
    expect(last().closedByClient).toBe(1000);
    expect(client.denial()).toBe('session-expired');
  });

  it('show de outro produtor chega como forbidden só para ele', async () => {
    const one = watch('show-1');
    const two = watch('show-2');
    await accept();

    last().receive({ type: 'error', code: 'forbidden', detail: 'Show', showId: 'show-2' });
    last().receive({ type: 'error', code: 'bad-request', detail: 'type' });

    expect(one.events).toEqual([]);
    expect(two.events).toEqual([{ type: 'forbidden', detail: 'Show' }]);
    expect(client.status()).toBe('live');
  });

  it('sem nenhuma mensagem por muito tempo, troca a conexão morta por uma nova', async () => {
    watch('show-1');
    await accept();

    // Métricas chegando a cada segundo mantêm a conexão.
    for (let i = 0; i < 20; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      last().receive({ type: 'metrics', showId: 'show-1', metrics: liveMetrics() });
    }
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets[0].closedByClient).toBe(1000);
    expect(client.status()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('sem rede, espera o navegador voltar a ficar on-line', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      watch('show-1');
      await accept();
      last().serverClose(1006);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(sockets).toHaveLength(1);
      expect(client.status()).toBe('reconnecting');

      onLine.mockReturnValue(true);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(2);
    } finally {
      onLine.mockRestore();
    }
  });

  it('"tentar agora" reconecta sem esperar a próxima tentativa', async () => {
    watch('show-1');
    await accept();
    last().serverClose(1006);
    expect(client.retryAt()).toBe(Date.now() + 1_000);

    client.retryNow();
    expect(sockets).toHaveLength(2);
    expect(client.retryAt()).toBeNull();
  });

  it('marca a hora da última mensagem do servidor', async () => {
    watch('show-1');
    expect(client.lastMessageAt()).toBeNull();
    await accept();
    expect(client.lastMessageAt()).toBe(Date.now());
  });
});

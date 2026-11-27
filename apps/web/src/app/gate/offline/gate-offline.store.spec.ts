import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NetworkStatus } from '../../core/ui/network-status';
import { CheckinShow } from '../data/checkin.api';
import { GateSettings } from '../gate-settings';
import { MemoryGateOfflineDb, PendingScan } from './gate-offline-db';
import { GATE_OFFLINE_DB } from './gate-offline-db';
import {
  GateOfflineStore,
  PACKAGE_REFRESH_MS,
  SERVER_RETRY_MS,
  SYNC_MS,
  SyncNotice,
  batches,
} from './gate-offline.store';
import { CAMAROTE, T1, T2, T3, T4, TestKeys, testKeys, testPackage } from './offline.testing';

const NOW = Date.parse('2026-12-16T23:30:00Z');
const PACKAGE_URL = '/api/v1/checkins/shows/s1/offline-package';
const OFFLINE_URL = '/api/v1/checkins/offline';

const SHOW: CheckinShow = {
  showId: 's1',
  title: 'Turnê',
  artist: 'Banda do Mar',
  startsAt: '2026-12-17T00:00:00Z',
  timezone: 'America/Recife',
  doorsOpenAt: '2026-12-16T21:00:00Z',
  venueName: 'Arena',
};

describe('GateOfflineStore', () => {
  let keys: TestKeys;
  let db: MemoryGateOfflineDb;
  let online: WritableSignal<boolean>;
  let http: HttpTestingController;
  let store: GateOfflineStore;
  let notices: SyncNotice[];

  beforeAll(async () => {
    keys = await testKeys();
  });

  function create() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        GateOfflineStore,
        { provide: GATE_OFFLINE_DB, useValue: db },
        { provide: NetworkStatus, useValue: { online } },
      ],
    });
    TestBed.inject(GateSettings).deviceId();
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(GateOfflineStore);
    notices = [];
    store.notices.subscribe((notice) => notices.push(notice));
  }

  /** Abre o show e responde o primeiro pacote. */
  async function open(pkg: object | null = testPackage(keys.publicKey)) {
    store.open('s1');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    if (pkg) {
      http.expectOne(PACKAGE_URL).flush(pkg);
      await vi.advanceTimersByTimeAsync(0);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    db = new MemoryGateOfflineDb();
    online = signal(true);
    create();
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  it('baixa o pacote ao abrir e guarda no aparelho, com a hora e o show', async () => {
    await open();
    store.remember(SHOW);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stored()?.savedAt).toBe(new Date(NOW).toISOString());
    const saved = await db.loadPackage('s1');
    expect(saved?.pkg.tickets).toHaveLength(4);
    expect(saved?.show?.artist).toBe('Banda do Mar');
  });

  it('atualiza o pacote a cada 2 minutos, só com internet', async () => {
    await open();
    await vi.advanceTimersByTimeAsync(PACKAGE_REFRESH_MS);
    http.expectOne(PACKAGE_URL).flush(testPackage(keys.publicKey, { tickets: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.stored()?.pkg.tickets).toEqual([]);

    online.set(false);
    await vi.advanceTimersByTimeAsync(PACKAGE_REFRESH_MS);
    http.expectNone(PACKAGE_URL);
  });

  it('valida o LOTOU2 com a chave do pacote, guarda a entrada na fila e barra a segunda', async () => {
    await open();
    const code = await keys.code(T1);
    const first = await store.check(code, 'Portão A', []);
    expect(first?.response).toMatchObject({ result: 'ACCEPTED', ticket: { sectorName: 'Pista' } });
    expect(store.pending()).toBe(1);
    expect(store.isUnsent(code)).toBe(true);
    const [scan] = await db.pending();
    expect(scan).toMatchObject({
      code,
      showId: 's1',
      gate: 'Portão A',
      ticketId: T1,
      scannedAt: new Date(NOW).toISOString(),
      deviceId: TestBed.inject(GateSettings).deviceId(),
    });
    expect(scan.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);

    const second = await store.check(code, 'Portão B', []);
    expect(second?.response).toMatchObject({
      result: 'ALREADY_USED',
      firstEntry: { at: new Date(NOW).toISOString(), gate: 'Portão A' },
    });
    expect(store.pending()).toBe(1);
  });

  it('assinatura adulterada, usado, cancelado e setor de outro portão', async () => {
    await open();
    const code = await keys.code(T1);
    const forged = `${code.slice(0, -2)}${code.endsWith('AA') ? 'BB' : 'AA'}`;
    const result = async (value: string, sectors: string[] = []) =>
      (await store.check(value, 'Portão A', sectors))?.response.result;
    expect(await result(forged)).toBe('INVALID_CODE');
    expect(await result(await keys.code(T2))).toBe('ALREADY_USED');
    expect(await result(await keys.code(T3))).toBe('CANCELLED');
    expect(await result(await keys.code(T1), [CAMAROTE])).toBe('WRONG_SECTOR');
    expect(await result(await (await testKeys()).code(T4))).toBe('INVALID_CODE');
    expect(store.pending()).toBe(0);
  });

  it('o LOTOU1 vale só se o ingresso estiver no pacote', async () => {
    await open();
    expect((await store.check(`LOTOU1.${T4}.${'a'.repeat(43)}`, 'A', []))?.response.result).toBe(
      'ACCEPTED',
    );
    const unknown = '0192a1b2-c3d4-7e5f-8a9b-0000000000ff';
    expect(
      (await store.check(`LOTOU1.${unknown}.${'a'.repeat(43)}`, 'A', []))?.response.result,
    ).toBe('UNKNOWN_TICKET');
  });

  it('a regra da abertura sem horário definido vem do pacote', async () => {
    await open(
      testPackage(keys.publicKey, { doorsOpenAt: null, startsAt: '2026-12-18T00:00:00Z' }),
    );
    const decision = await store.check(await keys.code(T1), 'A', []);
    expect(decision?.response.result).toBe('NOT_OPEN');
    // O dia 17/12 começa à meia-noite de Recife (3h em UTC).
    expect(decision?.doorsOpenAt).toBe('2026-12-17T03:00:00.000Z');
  });

  it('sem pacote guardado, não decide', async () => {
    await open(null);
    http.expectOne(PACKAGE_URL).flush(null, { status: 503, statusText: 'Unavailable' });
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.check(await keys.code(T1), 'A', [])).toBeNull();
    expect(store.online()).toBe(false);
  });

  it('abre sem internet com o pacote e as leituras guardadas', async () => {
    await open();
    store.remember(SHOW);
    await store.check(await keys.code(T1), 'Portão A', []);

    // O app fechou e abriu de novo, sem internet.
    online.set(false);
    create();
    store.open('s1');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    http.expectNone(PACKAGE_URL);
    expect(store.stored()?.show?.artist).toBe('Banda do Mar');
    expect(store.pending()).toBe(1);
    expect(store.online()).toBe(false);
    expect((await store.check(await keys.code(T1), 'Portão B', []))?.response.result).toBe(
      'ALREADY_USED',
    );
  });

  it('a entrada confirmada pelo servidor passa a valer no aparelho', async () => {
    await open();
    store.confirmed(T1, '2026-12-16T23:20:00Z', 'Portão C');
    expect((await store.check(await keys.code(T1), 'A', []))?.response).toMatchObject({
      result: 'ALREADY_USED',
      firstEntry: { gate: 'Portão C' },
    });
    expect(await db.entries('s1')).toHaveLength(1);
  });

  describe('envio', () => {
    async function readOffline(ticketId = T1, gate = 'Portão A') {
      const code = await keys.code(ticketId);
      await store.check(code, gate, []);
      return code;
    }

    it('manda a fila quando a rede volta e tira o que foi registrado', async () => {
      await open();
      online.set(false);
      const code = await readOffline();
      online.set(true);
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);

      // A rede voltou: a lista é atualizada e a fila, enviada.
      http.expectOne(PACKAGE_URL).flush(testPackage(keys.publicKey));
      const request = http.expectOne(OFFLINE_URL);
      const [scan] = await db.pending();
      expect(request.request.body).toEqual({
        showId: 's1',
        gate: 'Portão A',
        deviceId: scan.deviceId,
        scans: [{ id: scan.id, code, scannedAt: scan.scannedAt }],
      });
      request.flush({ results: [{ id: scan.id, outcome: 'RECORDED' }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(await db.pending()).toEqual([]);
      expect(store.pending()).toBe(0);
      expect(store.isUnsent(code)).toBe(false);
      expect(notices).toEqual([]);
      // A entrada continua valendo no aparelho até a próxima lista.
      expect((await store.check(code, 'Portão B', []))?.response.result).toBe('ALREADY_USED');
    });

    it('entrada dupla e ingresso cancelado viram avisos, não erro', async () => {
      await open();
      await readOffline(T1);
      await readOffline(T4);
      await vi.advanceTimersByTimeAsync(SYNC_MS);
      const scans = await db.pending();
      const first = scans.find((scan) => scan.ticketId === T1)!;
      const second = scans.find((scan) => scan.ticketId === T4)!;
      http.expectOne(OFFLINE_URL).flush({
        results: [
          {
            id: first.id,
            outcome: 'DUPLICATE',
            firstEntry: { gate: 'Portão B', checkedInAt: '2026-12-16T23:29:00Z' },
          },
          { id: second.id, outcome: 'CONFLICT', kind: 'CANCELLED' },
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(notices.map((notice) => notice.result.outcome)).toEqual(['DUPLICATE', 'CONFLICT']);
      expect(notices[1].ticket?.sectorName).toBe('Camarote');
      expect(store.pending()).toBe(0);
    });

    it('a "entrada dupla" que é a própria leitura (a resposta online se perdeu) não vira aviso', async () => {
      await open();
      await readOffline(T1, 'Portão A');
      await vi.advanceTimersByTimeAsync(SYNC_MS);
      const [scan] = await db.pending();
      http.expectOne(OFFLINE_URL).flush({
        results: [
          {
            id: scan.id,
            outcome: 'DUPLICATE',
            firstEntry: { gate: 'Portão A', checkedInAt: '2026-12-16T23:29:56Z' },
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(notices).toEqual([]);
    });

    it('sem resposta, a fila fica e o leitor valida no aparelho por um tempo', async () => {
      await open();
      await readOffline();
      expect(store.shouldAskServer()).toBe(true);
      await vi.advanceTimersByTimeAsync(SYNC_MS);
      http.expectOne(OFFLINE_URL).flush(null, { status: 502, statusText: 'Bad Gateway' });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.pending()).toBe(1);
      expect(store.online()).toBe(false);
      expect(store.shouldAskServer()).toBe(false);
      expect(store.shouldAskServer(Date.now() + SERVER_RETRY_MS)).toBe(true);
    });

    it('sessão vencida: a fila espera o login', async () => {
      await open();
      await readOffline();
      await vi.advanceTimersByTimeAsync(SYNC_MS);
      http.expectOne(OFFLINE_URL).flush(null, { status: 401, statusText: 'Unauthorized' });
      await vi.advanceTimersByTimeAsync(0);
      expect(store.loginNeeded()).toBe(true);
      expect(store.pending()).toBe(1);
    });

    it('com o servidor fora e nada a enviar, a lista nova diz se ele voltou', async () => {
      await open();
      store.serverUnreachable();
      expect(store.online()).toBe(false);
      await vi.advanceTimersByTimeAsync(SYNC_MS);
      http.expectOne(PACKAGE_URL).flush(testPackage(keys.publicKey));
      await vi.advanceTimersByTimeAsync(0);
      expect(store.online()).toBe(true);
    });
  });

  it('separa a fila em lotes de até 500, por show, portão e aparelho', () => {
    const scan = (i: number, gate = 'A'): PendingScan => ({
      id: `id-${i}`,
      code: 'c',
      scannedAt: new Date(NOW + i).toISOString(),
      showId: 's1',
      gate,
      deviceId: 'd',
      ticketId: `t-${i}`,
    });
    const queue = [...Array.from({ length: 501 }, (_, i) => scan(i)), scan(900, 'B')];
    expect(batches(queue).map((batch) => batch.length)).toEqual([500, 1, 1]);
  });
});

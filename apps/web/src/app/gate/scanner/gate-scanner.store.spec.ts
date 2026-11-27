import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/auth/auth.service';
import { NetworkStatus } from '../../core/ui/network-status';
import { GATE_OFFLINE_DB, MemoryGateOfflineDb } from '../offline/gate-offline-db';
import { GateOfflineStore, SYNC_MS } from '../offline/gate-offline.store';
import {
  CAMAROTE,
  T1,
  T2,
  fakeVerifier,
  signedCode,
  testPackage,
} from '../offline/offline.testing';
import { SIGNATURE_VERIFIER } from '../offline/ticket-code';
import { GateFeedback } from './gate-feedback';
import {
  CHECKIN_TIMEOUT_MS,
  RESULT_MS,
  SUMMARY_POLL_MS,
  GateScannerStore,
} from './gate-scanner.store';
import { SAME_CODE_WINDOW_MS } from './scan-debounce';

const NOW = Date.parse('2026-12-16T23:30:00Z');
const PACKAGE_URL = '/api/v1/checkins/shows/s1/offline-package';
const SHOWS = [
  {
    showId: 's1',
    title: 'Turnê',
    artist: 'Banda',
    startsAt: '2026-12-17T00:00:00Z',
    timezone: 'America/Recife',
    doorsOpenAt: '2026-12-16T21:00:00Z',
    venueName: 'Arena',
  },
];

describe('GateScannerStore', () => {
  let store: GateScannerStore;
  let http: HttpTestingController;
  let feedback: { signal: ReturnType<typeof vi.fn>; unlock: ReturnType<typeof vi.fn> };
  let online: WritableSignal<boolean>;

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW });
    feedback = { signal: vi.fn(), unlock: vi.fn() };
    online = signal(true);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        GateScannerStore,
        GateOfflineStore,
        { provide: GateFeedback, useValue: feedback },
        { provide: AuthService, useValue: { login: vi.fn() } },
        { provide: NetworkStatus, useValue: { online } },
        { provide: GATE_OFFLINE_DB, useValue: new MemoryGateOfflineDb() },
        { provide: SIGNATURE_VERIFIER, useValue: fakeVerifier },
      ],
    });
    store = TestBed.inject(GateScannerStore);
    http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/v1/checkins/shows').flush(SHOWS);
    store.start('s1', 'Portão B');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    http
      .expectOne('/api/v1/checkins/shows/s1/summary')
      .flush({ checkedIn: 10, byGate: [{ gate: 'Portão B', count: 4 }], rejected: 1 });
    http.expectOne(PACKAGE_URL).flush(testPackage('chave'));
    await vi.advanceTimersByTimeAsync(0);
  });

  afterEach(() => {
    http.verify();
    vi.useRealTimers();
  });

  const checkin = () => http.expectOne('/api/v1/checkins');

  it('manda show, portão e código e mostra a entrada liberada', () => {
    expect(store.submit('  LOTOU1.t1.sig ', 'camera')).toBe(true);
    expect(store.checking()).toBe(true);
    expect(store.busy()).toBe(true);
    const request = checkin();
    expect(request.request.body).toEqual({ showId: 's1', gate: 'Portão B', code: 'LOTOU1.t1.sig' });
    request.flush({
      result: 'ACCEPTED',
      ticket: { ticketId: 't1', sectorName: 'Pista', seat: null },
      firstEntry: null,
    });
    expect(store.result()?.view).toMatchObject({ tone: 'ok', place: 'Pista' });
    expect(feedback.signal).toHaveBeenCalledWith('ok');
    // O contador sobe na hora.
    expect(store.summary()?.checkedIn).toBe(11);
    expect(store.gateCount()).toBe(5);
    expect(store.history()).toHaveLength(1);
  });

  it('o resultado some sozinho e o leitor fica pronto', () => {
    store.submit('A', 'camera');
    checkin().flush({ result: 'ACCEPTED', ticket: null, firstEntry: null });
    vi.advanceTimersByTime(RESULT_MS.ok - 1);
    expect(store.result()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(store.result()).toBeNull();
    expect(store.busy()).toBe(false);
  });

  it('a câmera não manda o mesmo código de novo dentro de alguns segundos', () => {
    store.submit('A', 'camera');
    checkin().flush({ result: 'ACCEPTED', ticket: null, firstEntry: null });
    store.dismiss();
    expect(store.submit('A', 'camera')).toBe(false);
    http.expectNone('/api/v1/checkins');

    vi.advanceTimersByTime(SAME_CODE_WINDOW_MS);
    expect(store.submit('A', 'camera')).toBe(true);
    checkin().flush({
      result: 'ALREADY_USED',
      ticket: null,
      firstEntry: { at: '2026-12-16T23:30:00Z', gate: 'Portão B' },
    });
    expect(store.result()?.view.tone).toBe('warn');
    expect(store.result()?.view.detail).toBe('Entrou às 20:30 pelo Portão B.');
  });

  it('a câmera não lê com resultado na tela nem com leitura a caminho', () => {
    store.submit('A', 'camera');
    expect(store.submit('B', 'camera')).toBe(false);
    checkin().flush({ result: 'INVALID_CODE', ticket: null, firstEntry: null });
    expect(store.submit('B', 'camera')).toBe(false);
    http.expectNone('/api/v1/checkins');
  });

  it('o código digitado substitui o resultado na tela', () => {
    store.submit('A', 'camera');
    checkin().flush({ result: 'INVALID_CODE', ticket: null, firstEntry: null });
    expect(store.submit('B', 'manual')).toBe(true);
    expect(store.result()).toBeNull();
    checkin().flush({ result: 'ACCEPTED', ticket: null, firstEntry: null });
    expect(store.result()?.view.tone).toBe('ok');
  });

  it('portões fechados dizem a hora de abertura no fuso do show', () => {
    store.submit('A', 'manual');
    checkin().flush({ result: 'NOT_OPEN', ticket: null, firstEntry: null });
    expect(store.result()?.view.detail).toBe('A entrada abre às 18:00.');
    expect(feedback.signal).toHaveBeenCalledWith('error');
  });

  it('sem resposta do servidor, valida no aparelho com o pacote do show', async () => {
    const code = signedCode(T1);
    store.submit(code, 'camera');
    checkin().error(new ProgressEvent('error'));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.checking()).toBe(false);
    expect(store.result()?.view).toMatchObject({
      tone: 'ok',
      title: 'Entrada liberada',
      place: 'Pista',
      offline: true,
    });
    expect(store.gateCount()).toBe(5);
    expect(store.offline.pending()).toBe(1);
  });

  it('servidor sem responder em 4 s: valida no aparelho', async () => {
    store.submit(signedCode(T2), 'manual');
    const request = checkin();
    await vi.advanceTimersByTimeAsync(CHECKIN_TIMEOUT_MS);
    expect(request.cancelled).toBe(true);
    expect(store.result()?.view).toMatchObject({
      tone: 'warn',
      title: 'Ingresso já utilizado',
      detail: 'Entrou às 20:10 pelo Portão A.',
      offline: true,
    });
  });

  it('sem internet, nem tenta o servidor; a segunda leitura é "já utilizado"', async () => {
    online.set(false);
    const code = signedCode(T1);
    store.submit(code, 'manual');
    await vi.advanceTimersByTimeAsync(0);
    http.expectNone('/api/v1/checkins');
    expect(store.result()?.view.tone).toBe('ok');

    store.submit(code, 'manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.result()?.view).toMatchObject({
      tone: 'warn',
      detail: 'Entrou às 20:30 pelo Portão B.',
      offline: true,
    });
  });

  it('o ingresso aceito aqui e ainda não enviado é decidido aqui, mesmo com internet', async () => {
    online.set(false);
    const code = signedCode(T1);
    store.submit(code, 'manual');
    await vi.advanceTimersByTimeAsync(0);
    online.set(true);
    store.submit(code, 'manual');
    await vi.advanceTimersByTimeAsync(0);
    http.expectNone('/api/v1/checkins');
    expect(store.result()?.view).toMatchObject({ tone: 'warn', offline: false });
  });

  it('sem internet, o portão que não atende o setor manda a pessoa para outro', async () => {
    store.start('s1', 'Portão B', [CAMAROTE]);
    online.set(false);
    store.submit(signedCode(T1), 'manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.result()?.view).toMatchObject({
      tone: 'warn',
      title: 'Setor de outro portão',
      place: 'Pista',
    });
    expect(store.offline.pending()).toBe(0);
  });

  it('sem rede e sem a lista do show, pede para ler de novo', async () => {
    store.start('outro', 'Portão B');
    online.set(false);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne('/api/v1/checkins/shows/outro/summary').flush({});
    store.submit('A', 'camera');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.result()?.view).toMatchObject({
      tone: 'error',
      title: 'Não foi possível validar',
    });
    expect(store.result()?.view.detail).toContain('não tem a lista do show');
    expect(store.checking()).toBe(false);
  });

  it('a entrada liberada online também vale na lista do aparelho', async () => {
    const code = signedCode(T1);
    store.submit(code, 'manual');
    checkin().flush({
      result: 'ACCEPTED',
      ticket: { ticketId: T1, sectorName: 'Pista', seat: null },
      firstEntry: null,
    });
    vi.advanceTimersByTime(SAME_CODE_WINDOW_MS);
    online.set(false);
    store.submit(code, 'manual');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.result()?.view).toMatchObject({
      tone: 'warn',
      detail: 'Entrou às 20:30 pelo Portão B.',
    });
  });

  it('a entrada dupla revelada no envio aparece nas últimas leituras', async () => {
    online.set(false);
    store.submit(signedCode(T1), 'manual');
    await vi.advanceTimersByTimeAsync(0);
    online.set(true);
    await vi.advanceTimersByTimeAsync(SYNC_MS);
    http.match('/api/v1/checkins/shows/s1/summary').forEach((poll) => poll.flush({}));
    const request = http.expectOne('/api/v1/checkins/offline');
    const [scan] = request.request.body.scans;
    request.flush({
      results: [
        {
          id: scan.id,
          outcome: 'DUPLICATE',
          firstEntry: { gate: 'Portão A', checkedInAt: '2026-12-16T23:20:00Z' },
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.history()[0]).toMatchObject({
      sync: true,
      view: {
        tone: 'warn',
        title: 'Entrada dupla detectada',
        detail: 'Já tinha entrado às 20:20 pelo Portão A.',
        place: 'Pista',
      },
    });
    // O aviso não ocupa a tela nem apita: a pessoa já entrou.
    expect(feedback.signal).toHaveBeenCalledTimes(1);
  });

  it('se a resposta se perdeu, o "já utilizado" pelo mesmo portão logo depois é a mesma pessoa', () => {
    store.submit('A', 'manual');
    checkin().flush(null, { status: 500, statusText: 'Internal Server Error' });
    store.submit('A', 'manual');
    checkin().flush({
      result: 'ALREADY_USED',
      ticket: { ticketId: 't1', sectorName: 'Pista', seat: null },
      firstEntry: { at: '2026-12-16T23:30:01Z', gate: 'Portão B' },
    });
    expect(store.result()?.view).toMatchObject({ tone: 'ok', title: 'Entrada liberada' });
  });

  it('um "já utilizado" de outro portão continua amarelo, mesmo depois de uma falha', () => {
    store.submit('A', 'manual');
    checkin().flush(null, { status: 500, statusText: 'Internal Server Error' });
    store.submit('A', 'manual');
    checkin().flush({
      result: 'ALREADY_USED',
      ticket: null,
      firstEntry: { at: '2026-12-16T23:30:01Z', gate: 'Portão A' },
    });
    expect(store.result()?.view.tone).toBe('warn');
  });

  it('não manda código vazio', () => {
    expect(store.submit('   ', 'manual')).toBe(false);
    http.expectNone('/api/v1/checkins');
  });

  it('confere o contador de tempos em tempos', async () => {
    await vi.advanceTimersByTimeAsync(SUMMARY_POLL_MS);
    http
      .expectOne('/api/v1/checkins/shows/s1/summary')
      .flush({ checkedIn: 30, byGate: [{ gate: 'Portão B', count: 12 }], rejected: 2 });
    expect(store.summary()?.checkedIn).toBe(30);
    expect(store.gateCount()).toBe(12);
  });

  it('guarda só as últimas leituras', () => {
    for (const code of ['A', 'B', 'C', 'D', 'E', 'F']) {
      store.submit(code, 'manual');
      checkin().flush({ result: 'INVALID_CODE', ticket: null, firstEntry: null });
    }
    expect(store.history()).toHaveLength(5);
  });
});

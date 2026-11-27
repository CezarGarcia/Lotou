import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/auth/auth.service';
import { GateFeedback } from './gate-feedback';
import { RESULT_MS, SUMMARY_POLL_MS, GateScannerStore } from './gate-scanner.store';
import { SAME_CODE_WINDOW_MS } from './scan-debounce';

const NOW = Date.parse('2026-12-16T23:30:00Z');
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

  beforeEach(async () => {
    vi.useFakeTimers({ now: NOW });
    feedback = { signal: vi.fn(), unlock: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        GateScannerStore,
        { provide: GateFeedback, useValue: feedback },
        { provide: AuthService, useValue: { login: vi.fn() } },
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

  it('sem rede, pede para ler de novo', () => {
    store.submit('A', 'camera');
    checkin().error(new ProgressEvent('error'));
    expect(store.result()?.view).toMatchObject({
      tone: 'error',
      title: 'Não foi possível validar',
    });
    expect(store.checking()).toBe(false);
  });

  it('se a resposta se perdeu, o "já utilizado" pelo mesmo portão logo depois é a mesma pessoa', () => {
    store.submit('A', 'manual');
    checkin().flush(null, { status: 504, statusText: 'Gateway Timeout' });
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
    checkin().flush(null, { status: 503, statusText: 'Unavailable' });
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

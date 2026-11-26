import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { SseError } from '../../core/http/sse';
import { QueueApi } from '../data/queue.api';
import { QueueStatus } from '../data/sale.models';
import { QueueStore } from './queue.store';

const status = (value: Partial<QueueStatus>): QueueStatus => ({
  showId: 's1',
  status: 'QUEUED',
  ...value,
});

describe('QueueStore', () => {
  let store: QueueStore;
  let events: Subject<QueueStatus>;
  let api: { join: ReturnType<typeof vi.fn>; events: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    events = new Subject();
    api = { join: vi.fn(), events: vi.fn(() => events) };
    TestBed.configureTestingModule({
      providers: [QueueStore, { provide: QueueApi, useValue: api }],
    });
    store = TestBed.inject(QueueStore);
  });

  const start = () => {
    store.start('s1');
    TestBed.tick();
  };

  it('entra na fila e acompanha a posição pelo SSE até a admissão', () => {
    api.join.mockReturnValue(of(status({ position: 120, estimatedWaitSeconds: 300 })));
    start();

    expect(api.join).toHaveBeenCalledWith('s1');
    expect(store.status()?.position).toBe(120);

    events.next(status({ position: 3, estimatedWaitSeconds: 10 }));
    expect(store.status()?.position).toBe(3);
    expect(store.canBuy()).toBe(false);

    events.next(status({ status: 'ADMITTED', admittedUntil: '2031-01-01T00:05:00Z' }));
    expect(store.canBuy()).toBe(true);
    // A admissão encerra o acompanhamento.
    expect(events.observed).toBe(false);
  });

  it('acompanha a sala de espera pelo mesmo fluxo', () => {
    api.join.mockReturnValue(of(status({ status: 'WAITING_ROOM' })));
    start();
    expect(store.status()?.status).toBe('WAITING_ROOM');

    events.next(status({ position: 42 }));
    expect(store.status()).toMatchObject({ status: 'QUEUED', position: 42 });
  });

  it('libera o checkout direto quando o show não exige fila', () => {
    api.join.mockReturnValue(of(status({ status: 'NOT_REQUIRED' })));
    start();
    expect(store.canBuy()).toBe(true);
    expect(api.events).not.toHaveBeenCalled();
  });

  it('expõe o erro e entra de novo no retry', () => {
    api.join.mockReturnValueOnce(
      throwError(() => new SseError({ status: 403, message: 'Proibido.' })),
    );
    start();
    expect(store.error()?.message).toBe('Proibido.');
    expect(store.loading()).toBe(false);

    api.join.mockReturnValueOnce(of(status({ status: 'NOT_IN_QUEUE' })));
    store.rejoin();
    TestBed.tick();
    expect(store.error()).toBeNull();
    expect(store.status()?.status).toBe('NOT_IN_QUEUE');
  });

  describe('antes da sala de espera abrir', () => {
    beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2031, 0, 1, 12, 0, 0) }));
    afterEach(() => vi.useRealTimers());

    it('espera a abertura e entra sozinho', () => {
      store.random = () => 0;
      api.join
        .mockReturnValueOnce(
          of(status({ status: 'NOT_OPEN', waitingRoomOpensAt: '2031-01-01T12:01:00Z' })),
        )
        .mockReturnValueOnce(of(status({ status: 'WAITING_ROOM' })));
      start();
      expect(store.status()?.status).toBe('NOT_OPEN');

      vi.advanceTimersByTime(59_999);
      expect(api.join).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(api.join).toHaveBeenCalledTimes(2);
      expect(store.status()?.status).toBe('WAITING_ROOM');
    });
  });
});

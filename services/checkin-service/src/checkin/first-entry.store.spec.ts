import type { Redis } from 'ioredis';
import {
  FirstEntryStore,
  PENDING_GRACE_MS,
  ttlMs,
} from './first-entry.store.js';

const TICKET = '01a21a00-0000-7000-8000-000000000013';
const NOW = new Date('2026-12-16T22:30:00Z');
const STARTS_AT = new Date('2026-12-16T23:30:00Z');
const HOUR = 60 * 60 * 1000;

/** Um Redis de mentira: só os comandos que a classe usa. */
function fakeRedis(changes: Partial<Record<'set' | 'get' | 'eval', unknown>>) {
  const redis = {
    set: vi.fn(async () => 'OK' as string | null),
    get: vi.fn(async () => null as string | null),
    eval: vi.fn(async () => 1),
    ...changes,
  };
  return { redis, store: new FirstEntryStore(redis as unknown as Redis) };
}

const stored = (at: Date, gate = 'Portão B') =>
  JSON.stringify({ at: at.toISOString(), gate });

describe('FirstEntryStore', () => {
  const entry = { at: NOW, gate: 'Portão A' };

  it('o primeiro portão marca com SET NX, valor {at, gate} e validade', async () => {
    const { redis, store } = fakeRedis({});
    expect(await store.claim(TICKET, entry, STARTS_AT)).toEqual({
      outcome: 'claimed',
    });
    expect(redis.set).toHaveBeenCalledWith(
      `checkin:${TICKET}`,
      stored(NOW, 'Portão A'),
      'PX',
      25 * HOUR,
      'NX',
    );
  });

  it('marca de outro portão há pouco: entrada em andamento, "já utilizado"', async () => {
    const earlier = new Date(NOW.getTime() - 300);
    const { store } = fakeRedis({
      set: vi.fn(async () => null),
      get: vi.fn(async () => stored(earlier)),
    });
    expect(await store.claim(TICKET, entry, STARTS_AT)).toEqual({
      outcome: 'taken',
      entry: { at: earlier, gate: 'Portão B' },
    });
  });

  it('marca mais velha que o prazo: velha, o banco decide', async () => {
    const old = new Date(NOW.getTime() - PENDING_GRACE_MS - 1);
    const { store } = fakeRedis({
      set: vi.fn(async () => null),
      get: vi.fn(async () => stored(old)),
    });
    expect((await store.claim(TICKET, entry, STARTS_AT)).outcome).toBe('stale');
  });

  it.each([
    [
      'o Redis fora do ar',
      { set: vi.fn(async () => Promise.reject(new Error('ECONNREFUSED'))) },
    ],
    ['a marca sumiu entre o SET e o GET', { set: vi.fn(async () => null) }],
    [
      'um valor ilegível',
      { set: vi.fn(async () => null), get: vi.fn(async () => 'lixo') },
    ],
  ])('com %s, o banco decide', async (_, changes) => {
    const { store } = fakeRedis(changes);
    expect(await store.claim(TICKET, entry, STARTS_AT)).toEqual({
      outcome: 'unavailable',
    });
  });

  it('desfaz a marca só se ainda for a deste portão', async () => {
    const { redis, store } = fakeRedis({});
    await store.release(TICKET, entry);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('GET', KEYS[1]) == ARGV[1]"),
      1,
      `checkin:${TICKET}`,
      stored(NOW, 'Portão A'),
    );
  });

  it('desfazer e lembrar não lançam com o Redis fora', async () => {
    const failing = vi.fn(async () => Promise.reject(new Error('fora')));
    const { store } = fakeRedis({ set: failing, eval: failing });
    await expect(store.release(TICKET, entry)).resolves.toBeUndefined();
    await expect(
      store.remember(TICKET, entry, STARTS_AT),
    ).resolves.toBeUndefined();
  });
});

describe('ttlMs', () => {
  it('até um dia depois do início do show', () => {
    expect(ttlMs(NOW, STARTS_AT)).toBe(25 * HOUR);
  });

  it('pelo menos uma hora, mesmo com o show no passado ou desconhecido', () => {
    expect(ttlMs(NOW, new Date('2026-01-01T00:00:00Z'))).toBe(HOUR);
    expect(ttlMs(NOW, undefined)).toBe(HOUR);
  });
});

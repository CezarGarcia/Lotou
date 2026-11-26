import { LocalCache } from './local-cache.js';

describe('LocalCache', () => {
  let now: number;
  const clock = () => now;

  beforeEach(() => {
    now = 0;
  });

  it('devolve o valor até o TTL e esquece depois', () => {
    const cache = new LocalCache<string>(2_000, 10, clock);
    cache.set('a', 'A');

    now = 1_999;
    expect(cache.get('a')).toBe('A');
    now = 2_000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('acima do tamanho máximo, despeja o usado há mais tempo', () => {
    const cache = new LocalCache<string>(2_000, 2, clock);
    cache.set('a', 'A');
    cache.set('b', 'B');
    // Ler `a` o torna o mais recente; quem sai é `b`.
    cache.get('a');
    cache.set('c', 'C');

    expect(cache.get('a')).toBe('A');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('C');
  });

  it('regravar renova o TTL, e apagar tira na hora', () => {
    const cache = new LocalCache<string>(2_000, 10, clock);
    cache.set('a', 'A');
    now = 1_500;
    cache.set('a', 'A2');
    now = 3_000;
    expect(cache.get('a')).toBe('A2');

    cache.delete('a');
    expect(cache.get('a')).toBeUndefined();
  });
});

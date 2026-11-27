import { CountPipe, formatCount } from './count.pipe';

describe('CountPipe', () => {
  it('separa milhares com ponto, sempre em pt-BR', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1_240)).toBe('1.240');
    expect(formatCount(1_234_567)).toBe('1.234.567');
  });

  it('devolve vazio quando não há valor', () => {
    const pipe = new CountPipe();
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform(2_000)).toBe('2.000');
  });
});

import { centsToBrlInput, parseBrlToCents } from './money-input';

describe('parseBrlToCents', () => {
  it.each([
    ['30', 3_000],
    ['30,5', 3_050],
    ['30,50', 3_050],
    ['0,01', 1],
    ['1.234,56', 123_456],
    ['1.234', 123_400],
    ['R$ 30,00', 3_000],
    ['  12,3  ', 1_230],
    ['30.5', 3_050],
    ['19.99', 1_999],
    ['0', 0],
  ])('"%s" vira %i centavos', (text, cents) => {
    expect(parseBrlToCents(text)).toBe(cents);
  });

  it.each(['', '   ', 'abc', '30,555', '-10', '1,2,3', '12.34.5', '30,', ',50', '1e3', '0x10'])(
    'recusa "%s"',
    (text) => {
      expect(parseBrlToCents(text)).toBeNull();
    },
  );

  it('não passa por ponto flutuante: 0,29 vira 29, não 28', () => {
    // 0.29 * 100 = 28.999999999999996 em ponto flutuante.
    expect(parseBrlToCents('0,29')).toBe(29);
    expect(parseBrlToCents('1.000.000,07')).toBe(100_000_007);
  });

  it('nulo ou indefinido vira null', () => {
    expect(parseBrlToCents(null)).toBeNull();
    expect(parseBrlToCents(undefined)).toBeNull();
  });
});

describe('centsToBrlInput', () => {
  it('formata para o campo, com vírgula e dois decimais', () => {
    expect(centsToBrlInput(3_050)).toBe('30,50');
    expect(centsToBrlInput(7)).toBe('0,07');
    expect(parseBrlToCents(centsToBrlInput(123_456))).toBe(123_456);
  });
});

import { MoneyPipe, formatCents } from './money.pipe';

// O Intl separa "R$" do valor com um espaço não separável.
const plain = (text: string) => text.replace(/ /g, ' ');

describe('MoneyPipe', () => {
  it('formata centavos como reais', () => {
    expect(plain(formatCents(18_000))).toBe('R$ 180,00');
    expect(plain(formatCents(12_050))).toBe('R$ 120,50');
    expect(plain(formatCents(0))).toBe('R$ 0,00');
    expect(plain(formatCents(123_456_789))).toBe('R$ 1.234.567,89');
  });

  it('devolve vazio quando não há valor', () => {
    const pipe = new MoneyPipe();
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(plain(pipe.transform(990))).toBe('R$ 9,90');
  });
});

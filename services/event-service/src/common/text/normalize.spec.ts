import { escapeRegExp, normalizeText } from './normalize.js';

describe('normalizeText', () => {
  it('remove acentos, caixa e espaços sobrando', () => {
    expect(normalizeText('  São   Paulo ')).toBe('sao paulo');
    expect(normalizeText('ANITTA')).toBe('anitta');
    expect(normalizeText('Emicida & Criolo')).toBe('emicida & criolo');
  });

  it('trata "Belém" e "belem" como a mesma cidade', () => {
    expect(normalizeText('Belém')).toBe(normalizeText('belem'));
  });
});

describe('escapeRegExp', () => {
  it('torna literais os caracteres especiais de regex', () => {
    const pattern = new RegExp(escapeRegExp('a.c (ao vivo)'));
    expect(pattern.test('a.c (ao vivo)')).toBe(true);
    expect(pattern.test('abc (ao vivo)')).toBe(false);
  });
});

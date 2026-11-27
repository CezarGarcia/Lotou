import { CARTAZ_PALETTES, cartazPalette } from './cartaz-palette';

describe('cartazPalette', () => {
  it('dá sempre a mesma tinta ao mesmo artista', () => {
    expect(cartazPalette('Marina Céu')).toEqual(cartazPalette('Marina Céu'));
  });

  it('espalha os artistas pelas tintas', () => {
    const artists = Array.from({ length: 60 }, (_, index) => `Artista ${index}`);
    const used = new Set(artists.map((artist) => cartazPalette(artist).name));
    expect(used.size).toBe(CARTAZ_PALETTES.length);
  });
});

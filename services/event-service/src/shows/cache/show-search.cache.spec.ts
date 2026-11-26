import { searchShowsQuerySchema } from '../shows.schemas.js';
import { searchKey } from './show-search.cache.js';

const keyOf = (query: Record<string, string>) =>
  searchKey(searchShowsQuerySchema.parse(query));

describe('searchKey', () => {
  it('usa o hash da consulta, sem o texto dela', () => {
    const key = keyOf({ artist: 'Marina Céu' });
    expect(key).toMatch(/^cache:events:[0-9a-f]{64}$/);
    expect(key).not.toContain('marina');
  });

  it('dá a mesma chave para consultas com o mesmo resultado', () => {
    expect(keyOf({ artist: '  Céu ', city: 'SÃO PAULO', limit: '20' })).toBe(
      keyOf({ city: 'sao paulo', artist: 'ceu' }),
    );
  });

  it('dá chaves diferentes quando muda filtro, período, tamanho ou cursor', () => {
    const cursor = Buffer.from(
      JSON.stringify([
        1_800_000_000_000,
        '019ac0d6-1f4e-7a3b-8c2d-5e6f7a8b9c0d',
      ]),
    ).toString('base64url');
    const keys = [
      keyOf({}),
      keyOf({ artist: 'ceu' }),
      keyOf({ city: 'ceu' }),
      keyOf({ from: '2030-01-01' }),
      keyOf({ to: '2030-01-01' }),
      keyOf({ limit: '5' }),
      keyOf({ cursor }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

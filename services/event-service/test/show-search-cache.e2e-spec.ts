import { CacheMetrics } from '../src/cache/cache-metrics.js';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createVenue,
  showAt,
  type VenueBody,
} from './support/fixtures.js';

describe('Cache da busca de shows', () => {
  let t: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;

  const artists = async (query: string): Promise<string[]> =>
    (await t.anonymous.get(`/v1/shows${query}`).expect(200)).body.items.map(
      (show: { artist: string }) => show.artist,
    );
  const searchKeys = () => t.redisCache.keys('cache:events:*');

  beforeAll(async () => {
    t = await createTestApp();
    producer = await t.as('producer');
    venue = await createVenue(producer);
  });
  beforeEach(() => t.redisCache.flushdb());
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => t.close());

  it('guarda a página de resultados por 60 s', async () => {
    await createPublishedShow(producer, showAt(venue, { artist: 'Coral Sul' }));

    const response = await t.anonymous
      .get('/v1/shows?artist=coral')
      .expect(200);

    const [key] = await searchKeys();
    expect(key).toMatch(/^cache:events:[0-9a-f]{64}$/);
    expect(JSON.parse((await t.redisCache.get(key))!)).toEqual(response.body);
    const ttl = await t.redisCache.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('só sai pelo TTL: um show novo aparece depois que a chave expira', async () => {
    await createPublishedShow(producer, showAt(venue, { artist: 'Duo Norte' }));
    expect(await artists('?artist=duo')).toEqual(['Duo Norte']);

    await createPublishedShow(producer, showAt(venue, { artist: 'Duo Oeste' }));
    // Até 1 minuto de atraso, aceito para a listagem.
    expect(await artists('?artist=duo')).toEqual(['Duo Norte']);

    const [key] = await searchKeys();
    await t.redisCache.pexpire(key, 1);
    await vi.waitFor(async () =>
      expect(await t.redisCache.exists(key)).toBe(0),
    );
    expect(await artists('?artist=duo')).toEqual(['Duo Norte', 'Duo Oeste']);
  });

  it('consultas equivalentes usam a mesma chave', async () => {
    const metrics = vi.spyOn(t.app.get(CacheMetrics), 'record');

    await artists('?artist=Céu&city=São Paulo');
    await artists('?city=sao paulo&artist=  ceu  &limit=20');

    expect(await searchKeys()).toHaveLength(1);
    expect(metrics.mock.calls).toEqual([
      ['events', 'miss'],
      ['events', 'hit'],
    ]);
  });

  it('consultas diferentes usam chaves diferentes', async () => {
    await artists('?artist=ceu');
    await artists('?artist=ceu&limit=5');
    await artists('?artist=ceu&from=2030-01-01');

    expect(await searchKeys()).toHaveLength(3);
  });
});

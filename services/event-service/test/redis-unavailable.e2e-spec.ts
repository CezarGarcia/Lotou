import { CacheMetrics } from '../src/cache/cache-metrics.js';
import { newId } from '../src/common/ids/id.js';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createShow,
  createVenue,
  showAt,
  type VenueBody,
} from './support/fixtures.js';

// Ninguém escuta na porta 1: a conexão é recusada na hora.
const NOWHERE = 'redis://127.0.0.1:1';

describe('Com o Redis fora do ar', () => {
  let t: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;

  beforeAll(async () => {
    t = await createTestApp({
      env: { REDIS_CACHE_URL: NOWHERE, REDIS_CORE_URL: NOWHERE },
    });
    producer = await t.as('producer');
    venue = await createVenue(producer);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => t.close());

  it('a página do show vem do MongoDB e conta como erro de cache', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    const draft = await createShow(producer, showAt(venue));
    const metrics = vi.spyOn(t.app.get(CacheMetrics), 'record');

    await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
    await t.anonymous.get(`/v1/shows/${newId()}`).expect(404);
    await producer.get(`/v1/shows/${draft.id}`).expect(200);
    await t.anonymous.get(`/v1/shows/${draft.id}`).expect(404);

    expect(metrics.mock.calls).toEqual(Array(4).fill(['event', 'error']));
  });

  it('a busca vem do MongoDB', async () => {
    await createPublishedShow(producer, showAt(venue, { artist: 'Sem Cache' }));
    const metrics = vi.spyOn(t.app.get(CacheMetrics), 'record');

    const found = await t.anonymous
      .get('/v1/shows?artist=sem cache')
      .expect(200);

    expect(found.body.items).toHaveLength(1);
    expect(metrics.mock.calls).toEqual([['events', 'error']]);
  });

  it('as escritas seguem funcionando, mesmo sem apagar o cache', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    await producer
      .patch(`/v1/shows/${show.id}`, { title: 'Novo', version: show.version })
      .expect(200);

    const found = await t.anonymous.get(`/v1/shows/${show.id}`).expect(200);
    expect(found.body.title).toBe('Novo');
  });

  it('o rate limit deixa passar, sem os cabeçalhos de cota', async () => {
    const response = await t.anonymous.get('/v1/venues').expect(200);
    expect(response.headers).not.toHaveProperty('ratelimit-limit');
  });
});

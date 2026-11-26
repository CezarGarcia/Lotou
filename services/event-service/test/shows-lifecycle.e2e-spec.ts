import { ShowsService } from '../src/shows/shows.service.js';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createShow,
  createVenue,
  daysFromNow,
  showAt,
  type VenueBody,
} from './support/fixtures.js';

describe('Abertura e encerramento das vendas', () => {
  let t: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;
  let shows: ShowsService;

  const statusOf = async (id: string) =>
    (await t.anonymous.get(`/v1/shows/${id}`).expect(200)).body.status;
  const minutesFromNow = (minutes: number) =>
    new Date(Date.now() + minutes * 60_000);

  beforeAll(async () => {
    t = await createTestApp();
    producer = await t.as('producer');
    venue = await createVenue(producer);
    shows = t.app.get(ShowsService);
  });
  afterAll(() => t.close());

  it('sem datas de venda, abre na publicação e fecha no início do show', async () => {
    const startsAt = daysFromNow(30);
    const show = await createPublishedShow(
      producer,
      showAt(venue, { startsAt }),
    );

    const published = (await t.anonymous.get(`/v1/shows/${show.id}`)).body;
    expect(published.salesStartAt).toBe(published.publishedAt);
    expect(published.salesEndAt).toBe(startsAt);
  });

  it('mantém as datas de venda que o produtor agendou', async () => {
    const salesStartAt = daysFromNow(5);
    const salesEndAt = daysFromNow(29);
    const show = await createPublishedShow(
      producer,
      showAt(venue, { startsAt: daysFromNow(30), salesStartAt, salesEndAt }),
    );

    const published = (await t.anonymous.get(`/v1/shows/${show.id}`)).body;
    expect(published).toMatchObject({ salesStartAt, salesEndAt });
  });

  it('PUBLISHED -> ON_SALE quando chega a abertura das vendas', async () => {
    const scheduled = await createPublishedShow(
      producer,
      showAt(venue, { salesStartAt: daysFromNow(5) }),
    );
    const immediate = await createPublishedShow(producer, showAt(venue));

    await shows.advanceLifecycle(minutesFromNow(1));

    expect(await statusOf(immediate.id)).toBe('ON_SALE');
    expect(await statusOf(scheduled.id)).toBe('PUBLISHED');
  });

  it('ON_SALE -> SALES_CLOSED no encerramento, uma única vez', async () => {
    const show = await createPublishedShow(
      producer,
      showAt(venue, { startsAt: daysFromNow(2) }),
    );
    await shows.advanceLifecycle(minutesFromNow(1));
    expect(await statusOf(show.id)).toBe('ON_SALE');

    const afterTheShow = new Date(daysFromNow(3));
    // Várias instâncias do job ao mesmo tempo: só uma altera o show.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => shows.advanceLifecycle(afterTheShow)),
    );

    expect(await statusOf(show.id)).toBe('SALES_CLOSED');
    const found = (await t.anonymous.get(`/v1/shows/${show.id}`)).body;
    // publicar (2), abrir (3) e encerrar (4): nenhuma transição repetida.
    expect(found.version).toBe(4);
    expect(results.reduce((sum, n) => sum + n, 0)).toBeGreaterThanOrEqual(1);
  });

  it('não mexe em rascunho, mesmo com a data de abertura no passado', async () => {
    const draft = await createShow(producer, showAt(venue));
    await shows.advanceLifecycle(new Date(daysFromNow(400)));

    const found = (await producer.get(`/v1/shows/${draft.id}`)).body;
    expect(found.status).toBe('DRAFT');
  });

  it('depois que as vendas abrem, o show não aceita mais edição', async () => {
    const show = await createPublishedShow(producer, showAt(venue));
    await shows.advanceLifecycle(minutesFromNow(1));

    const current = (await producer.get(`/v1/shows/${show.id}`)).body;
    const response = await producer
      .patch(`/v1/shows/${show.id}`, {
        title: 'Tarde demais',
        version: current.version,
      })
      .expect(409);
    expect(response.body.type).toBe('urn:lotou:problem:show-not-editable');
  });

  it('um show em venda continua aparecendo na busca', async () => {
    const show = await createPublishedShow(
      producer,
      showAt(venue, { artist: 'Em Venda Agora' }),
    );
    await shows.advanceLifecycle(minutesFromNow(1));

    const found = (await t.anonymous.get('/v1/shows?artist=em venda agora'))
      .body;
    expect(found.items.map((s: { id: string }) => s.id)).toEqual([show.id]);
    expect(found.items[0].status).toBe('ON_SALE');
  });
});

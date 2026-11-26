import { validate, version } from 'uuid';
import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import { arena, createShow, createVenue, showAt } from './support/fixtures.js';

describe('Locais', () => {
  let t: TestApp;
  let producer: ApiClient;

  beforeAll(async () => {
    t = await createTestApp();
    producer = await t.as('producer');
  });
  afterAll(() => t.close());

  it('cria um local com ID em UUID v7 e devolve o Location', async () => {
    const response = await producer.post('/v1/venues', arena).expect(201);
    const venue = response.body;

    expect(validate(venue.id) && version(venue.id)).toBe(7);
    expect(response.headers.location).toBe(`/v1/venues/${venue.id}`);
    expect(venue).toMatchObject({
      name: 'Arena Lotou',
      address: { city: 'São Paulo', state: 'SP' },
      timezone: 'America/Sao_Paulo',
      capacity: 2500,
      version: 1,
    });
    expect(venue.sectors.map((s: { id: string }) => version(s.id))).toEqual([
      7, 7,
    ]);
    expect(venue).not.toHaveProperty('_id');
    expect(venue).not.toHaveProperty('createdBy');

    const found = await t.anonymous.get(`/v1/venues/${venue.id}`).expect(200);
    expect(found.body).toEqual(venue);
  });

  it('responde 400 com um erro por campo inválido', async () => {
    const response = await producer
      .post('/v1/venues', {
        ...arena,
        name: '   ',
        timezone: 'Sao_Paulo',
        address: { city: 'São Paulo', state: 'São Paulo' },
        sectors: [{ name: 'Pista', kind: 'VIP', capacity: 0 }],
      })
      .expect(400);

    expect(response.body.type).toBe('urn:lotou:problem:validation-error');
    expect(
      response.body.errors.map((e: { field: string }) => e.field).sort(),
    ).toEqual([
      'address.state',
      'name',
      'sectors.0.capacity',
      'sectors.0.kind',
      'timezone',
    ]);
  });

  it('recusa setores com o mesmo nome e ID que não é UUID v7', async () => {
    const duplicated = await producer
      .post('/v1/venues', {
        ...arena,
        sectors: [arena.sectors[0], { ...arena.sectors[0], name: 'PISTA' }],
      })
      .expect(400);
    expect(duplicated.body.errors[0].field).toBe('sectors');

    await t.anonymous.get('/v1/venues/123').expect(400);
    await t.anonymous
      .get('/v1/venues/0198c2f4-7f8e-7abc-8def-0123456789ab')
      .expect(404);
  });

  it('lista por cursor, do mais novo ao mais antigo, sem repetir', async () => {
    const created: string[] = [];
    for (let i = 1; i <= 5; i++) {
      created.push((await createVenue(producer, { name: `Casa ${i}` })).id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/venues?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await t.anonymous.get(url).expect(200)).body;
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((v: { id: string }) => v.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(new Set(seen).size).toBe(seen.length);
    // Os cinco locais criados aqui vêm primeiro, do mais novo ao mais antigo.
    expect(seen.slice(0, 5)).toEqual(created.toReversed());
  });

  it('recusa parâmetro desconhecido e cursor adulterado na listagem', async () => {
    await t.anonymous.get('/v1/venues?limt=2').expect(400);
    await t.anonymous.get('/v1/venues?limit=1000').expect(400);
    await t.anonymous.get('/v1/venues?cursor=abc').expect(400);
  });

  it('altera só os campos enviados e sobe a versão', async () => {
    const venue = await createVenue(producer);
    const response = await producer
      .patch(`/v1/venues/${venue.id}`, { name: 'Arena Nova', version: 1 })
      .expect(200);

    expect(response.body).toMatchObject({
      name: 'Arena Nova',
      timezone: 'America/Sao_Paulo',
      version: 2,
    });
    expect(response.body.sectors).toEqual(venue.sectors);
  });

  it('responde 409 quando a versão enviada está desatualizada', async () => {
    const venue = await createVenue(producer);
    await producer
      .patch(`/v1/venues/${venue.id}`, { name: 'Primeira', version: 1 })
      .expect(200);
    const response = await producer
      .patch(`/v1/venues/${venue.id}`, { name: 'Segunda', version: 1 })
      .expect(409);

    expect(response.body.type).toBe('urn:lotou:problem:version-conflict');
  });

  it('só o produtor que cadastrou o local pode alterá-lo', async () => {
    const venue = await createVenue(producer);
    const other = await t.as('producer');
    await other
      .patch(`/v1/venues/${venue.id}`, { name: 'Invasão', version: 1 })
      .expect(403);
  });

  it('propaga nome e cidade para os shows e trava os setores em uso', async () => {
    const venue = await createVenue(producer);
    const show = await createShow(producer, showAt(venue));

    await producer
      .patch(`/v1/venues/${venue.id}`, {
        name: 'Arena Rebatizada',
        address: { city: 'Campinas', state: 'SP' },
        version: 1,
      })
      .expect(200);
    const updatedShow = await producer.get(`/v1/shows/${show.id}`).expect(200);
    expect(updatedShow.body.venue).toMatchObject({
      name: 'Arena Rebatizada',
      city: 'Campinas',
    });

    const response = await producer
      .patch(`/v1/venues/${venue.id}`, {
        sectors: [
          { name: 'Pista única', kind: 'GENERAL_ADMISSION', capacity: 10 },
        ],
        version: 2,
      })
      .expect(409);
    expect(response.body.type).toBe('urn:lotou:problem:venue-in-use');
  });
});

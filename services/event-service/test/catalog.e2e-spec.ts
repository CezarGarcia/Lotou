import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createShow,
  createVenue,
  showAt,
  type VenueBody,
} from './support/fixtures.js';

const CATALOG = '/internal/v1/catalog/shows';

describe('Catálogo interno (para os outros serviços)', () => {
  let t: TestApp;
  let producer: ApiClient;
  let service: ApiClient;
  let venue: VenueBody;

  beforeAll(async () => {
    t = await createTestApp();
    producer = await t.as('producer');
    service = await t.as('service');
    venue = await createVenue(producer);
  });
  afterAll(() => t.close());

  it('só aceita conta de serviço', async () => {
    await t.anonymous.get(CATALOG).expect(401);
    await producer.get(CATALOG).expect(403);
    await (await t.as('buyer')).get(CATALOG).expect(403);
    await service.get(CATALOG).expect(200);
  });

  it('devolve o show publicado com setores, fileiras e lotes; rascunho fica de fora', async () => {
    const draft = await createShow(producer, showAt(venue));
    const published = await createPublishedShow(
      producer,
      showAt(venue, {
        highDemand: true,
        sectors: [
          {
            sectorId: venue.sectors[0].id,
            lots: [{ name: '1º lote', priceCents: 12_000, quantity: 1000 }],
          },
          {
            sectorId: venue.sectors[1].id,
            lots: [{ name: 'Lote único', priceCents: 30_000, quantity: 500 }],
          },
        ],
      }),
    );

    const { items } = (await service.get(`${CATALOG}?limit=100`).expect(200))
      .body;
    const ids = items.map((show: { id: string }) => show.id);
    expect(ids).toContain(published.id);
    expect(ids).not.toContain(draft.id);

    const show = items.find((item: { id: string }) => item.id === published.id);
    expect(show).toMatchObject({
      status: 'PUBLISHED',
      version: 2,
      highDemand: true,
      producerId: expect.any(String),
      salesStartAt: expect.any(String),
      salesEndAt: expect.any(String),
    });
    expect(show.sectors).toEqual([
      {
        id: venue.sectors[0].id,
        name: 'Pista',
        kind: 'GENERAL_ADMISSION',
        capacity: 2000,
        rows: [],
        lots: [
          {
            id: expect.any(String),
            name: '1º lote',
            priceCents: 12_000,
            quantity: 1000,
            opensAt: null,
          },
        ],
      },
      {
        id: venue.sectors[1].id,
        name: 'Cadeira inferior',
        kind: 'RESERVED_SEATING',
        capacity: 500,
        rows: expect.arrayContaining([{ label: 'A', seatCount: 50 }]),
        lots: [expect.objectContaining({ name: 'Lote único', quantity: 500 })],
      },
    ]);
    expect(show.sectors[1].rows).toHaveLength(10);
  });

  it('entrega só o que mudou depois de updatedAfter, em ordem de alteração', async () => {
    const first = await createPublishedShow(producer, showAt(venue));
    const all = (await service.get(`${CATALOG}?limit=100`)).body.items;
    const lastSeen = all.at(-1).updatedAt;
    expect(all.at(-1).id).toBe(first.id);

    const nothing = (await service.get(`${CATALOG}?updatedAfter=${lastSeen}`))
      .body;
    expect(nothing).toEqual({ items: [], nextCursor: null });

    const second = await createPublishedShow(producer, showAt(venue));
    // Uma edição também faz o show voltar a aparecer.
    await producer
      .patch(`/v1/shows/${first.id}`, {
        title: 'Novo título',
        version: first.version,
      })
      .expect(200);

    const changed = (await service.get(`${CATALOG}?updatedAfter=${lastSeen}`))
      .body.items;
    expect(changed.map((show: { id: string }) => show.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(changed[1].version).toBe(first.version + 1);
  });

  it('pagina por cursor sem repetir shows', async () => {
    const all = (await service.get(`${CATALOG}?limit=100`)).body.items;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `${CATALOG}?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const page = (await service.get(url).expect(200)).body;
      seen.push(...page.items.map((show: { id: string }) => show.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(all.map((show: { id: string }) => show.id));
  });
});

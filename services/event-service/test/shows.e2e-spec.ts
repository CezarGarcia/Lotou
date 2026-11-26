import { type ApiClient, createTestApp, type TestApp } from './support/app.js';
import {
  createPublishedShow,
  createShow,
  createVenue,
  daysFromNow,
  showAt,
  type VenueBody,
} from './support/fixtures.js';

describe('Shows', () => {
  let t: TestApp;
  let producer: ApiClient;
  let venue: VenueBody;

  beforeAll(async () => {
    t = await createTestApp();
    producer = await t.as('producer');
    venue = await createVenue(producer);
  });
  afterAll(() => t.close());

  describe('rascunho', () => {
    it('cria o show como DRAFT, com setores copiados do local', async () => {
      const response = await producer
        .post('/v1/shows', showAt(venue))
        .expect(201);
      const show = response.body;

      expect(response.headers.location).toBe(`/v1/shows/${show.id}`);
      expect(show).toMatchObject({
        title: 'Turnê Horizonte',
        artist: 'Marina Céu',
        status: 'DRAFT',
        highDemand: false,
        venue: {
          id: venue.id,
          name: 'Arena Lotou',
          city: 'São Paulo',
          state: 'SP',
          timezone: 'America/Sao_Paulo',
        },
        priceFromCents: 12_000,
        publishedAt: null,
        version: 1,
      });
      expect(show.sectors).toEqual([
        {
          id: venue.sectors[0].id,
          name: 'Pista',
          kind: 'GENERAL_ADMISSION',
          capacity: 2000,
          lots: [
            expect.objectContaining({ name: '1º lote', priceCents: 12_000 }),
            expect.objectContaining({ name: '2º lote', priceCents: 16_000 }),
          ],
        },
      ]);
      // Campos internos não fazem parte do contrato.
      for (const field of ['_id', 'producerId', 'artistSearch', 'startsOn']) {
        expect(show).not.toHaveProperty(field);
      }
      expect(show.venue).not.toHaveProperty('citySearch');
    });

    it('aceita um rascunho só com título, artista e data', async () => {
      const show = await createShow(producer, {
        title: 'Em breve',
        artist: 'A confirmar',
        startsAt: daysFromNow(90),
      });
      expect(show).toMatchObject({ status: 'DRAFT', venue: null, sectors: [] });
    });

    it('só o dono enxerga o rascunho', async () => {
      const show = await createShow(producer, showAt(venue));
      const other = await t.as('producer');

      await producer.get(`/v1/shows/${show.id}`).expect(200);
      await t.anonymous.get(`/v1/shows/${show.id}`).expect(404);
      await other.get(`/v1/shows/${show.id}`).expect(404);

      const search = await t.anonymous.get('/v1/shows').expect(200);
      expect(search.body.items.map((s: { id: string }) => s.id)).not.toContain(
        show.id,
      );
    });

    it('exige data com fuso explícito e preço inteiro em centavos', async () => {
      const response = await producer
        .post(
          '/v1/shows',
          showAt(venue, {
            startsAt: '2027-03-20T20:00:00',
            sectors: [
              {
                sectorId: venue.sectors[0].id,
                lots: [{ name: 'Lote', priceCents: 120.5, quantity: 10 }],
              },
            ],
          }),
        )
        .expect(400);

      expect(
        response.body.errors.map((e: { field: string }) => e.field).sort(),
      ).toEqual(['sectors.0.lots.0.priceCents', 'startsAt']);
    });
  });

  describe('capacidade e lotes', () => {
    it('recusa a soma dos lotes acima da capacidade do setor', async () => {
      const response = await producer
        .post(
          '/v1/shows',
          showAt(venue, {
            sectors: [
              {
                sectorId: venue.sectors[0].id,
                lots: [
                  { name: '1º lote', priceCents: 10_000, quantity: 1500 },
                  { name: '2º lote', priceCents: 12_000, quantity: 501 },
                ],
              },
            ],
          }),
        )
        .expect(422);

      expect(response.body).toMatchObject({
        type: 'urn:lotou:problem:business-rule-violation',
        errors: [
          {
            field: 'sectors.0.lots',
            message:
              'A soma dos lotes (2001) passa da capacidade do setor (2000)',
          },
        ],
      });
    });

    it('recusa capacidade acima da do local, setor de outro local e local inexistente', async () => {
      const otherVenue = await createVenue(producer, { name: 'Outro local' });
      const cases = [
        {
          body: {
            sectors: [
              { sectorId: venue.sectors[1].id, capacity: 501, lots: [] },
            ],
          },
          field: 'sectors.0.capacity',
        },
        {
          body: {
            sectors: [{ sectorId: otherVenue.sectors[0].id, lots: [] }],
          },
          field: 'sectors.0.sectorId',
        },
        {
          body: { venueId: '0198c2f4-7f8e-7abc-8def-0123456789ab' },
          field: 'venueId',
        },
      ];

      for (const { body, field } of cases) {
        const response = await producer
          .post('/v1/shows', showAt(venue, body))
          .expect(422);
        expect(response.body.errors[0].field).toBe(field);
      }
    });

    it('recusa datas fora de ordem', async () => {
      const response = await producer
        .post(
          '/v1/shows',
          showAt(venue, {
            startsAt: daysFromNow(60),
            doorsOpenAt: daysFromNow(61),
            salesStartAt: daysFromNow(62),
          }),
        )
        .expect(422);
      expect(
        response.body.errors.map((e: { field: string }) => e.field),
      ).toEqual(['doorsOpenAt', 'salesStartAt']);
    });
  });

  describe('publicação', () => {
    it('publica o rascunho e ele passa a aparecer para todos', async () => {
      const draft = await createShow(producer, showAt(venue));
      const response = await producer
        .post(`/v1/shows/${draft.id}/publish`, {}, null)
        .expect(200);

      expect(response.body).toMatchObject({ status: 'PUBLISHED', version: 2 });
      expect(response.body.publishedAt).toEqual(expect.any(String));

      const found = await t.anonymous.get(`/v1/shows/${draft.id}`).expect(200);
      expect(found.body.status).toBe('PUBLISHED');
    });

    it('só publica com local, ao menos um setor e ao menos um lote', async () => {
      const incomplete = await createShow(producer, {
        title: 'Incompleto',
        artist: 'A confirmar',
        startsAt: daysFromNow(30),
      });
      const response = await producer
        .post(`/v1/shows/${incomplete.id}/publish`, {}, null)
        .expect(422);

      expect(response.body.type).toBe('urn:lotou:problem:show-not-publishable');
      expect(
        response.body.errors.map((e: { field: string }) => e.field),
      ).toEqual(['venueId', 'sectors']);

      const withoutLots = await createShow(
        producer,
        showAt(venue, {
          sectors: [{ sectorId: venue.sectors[0].id, lots: [] }],
        }),
      );
      const second = await producer
        .post(`/v1/shows/${withoutLots.id}/publish`, {}, null)
        .expect(422);
      expect(second.body.errors).toEqual([
        { field: 'sectors', message: 'Configure ao menos um lote' },
      ]);
    });

    it('recusa publicar duas vezes: a transição não está na tabela', async () => {
      const show = await createPublishedShow(producer, showAt(venue));
      const response = await producer
        .post(`/v1/shows/${show.id}/publish`, {}, null)
        .expect(409);

      expect(response.body).toMatchObject({
        type: 'urn:lotou:problem:invalid-state-transition',
        detail: 'Um show em PUBLISHED não pode ir para PUBLISHED.',
      });
    });

    it('publica uma única vez com 10 publicações simultâneas', async () => {
      const draft = await createShow(producer, showAt(venue));
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          producer.post(`/v1/shows/${draft.id}/publish`, {}, null),
        ),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(9);
      const found = await producer.get(`/v1/shows/${draft.id}`).expect(200);
      expect(found.body.version).toBe(2);
    });

    it('outro produtor não publica nem edita o show', async () => {
      const draft = await createShow(producer, showAt(venue));
      const other = await t.as('producer');

      await other.post(`/v1/shows/${draft.id}/publish`, {}, null).expect(404);
      await other
        .patch(`/v1/shows/${draft.id}`, { title: 'Invasão', version: 1 })
        .expect(404);
    });
  });

  describe('edição', () => {
    it('altera só os campos enviados e mantém o ID dos lotes existentes', async () => {
      const show = await createShow(producer, showAt(venue));
      const [firstLot] = show.sectors[0].lots;

      const response = await producer
        .patch(`/v1/shows/${show.id}`, {
          version: 1,
          highDemand: true,
          sectors: [
            {
              sectorId: venue.sectors[0].id,
              lots: [
                {
                  id: firstLot.id,
                  name: '1º lote',
                  priceCents: 13_000,
                  quantity: 500,
                },
                { name: 'Lote extra', priceCents: 18_000, quantity: 300 },
              ],
            },
          ],
        })
        .expect(200);

      expect(response.body).toMatchObject({
        title: 'Turnê Horizonte',
        highDemand: true,
        priceFromCents: 13_000,
        version: 2,
      });
      const lots = response.body.sectors[0].lots;
      expect(lots[0]).toMatchObject({ id: firstLot.id, priceCents: 13_000 });
      expect(lots[1].id).not.toBe(firstLot.id);
    });

    it('responde 409 quando a versão enviada está desatualizada', async () => {
      const show = await createShow(producer, showAt(venue));
      await producer
        .patch(`/v1/shows/${show.id}`, { title: 'Primeira', version: 1 })
        .expect(200);
      const response = await producer
        .patch(`/v1/shows/${show.id}`, { title: 'Segunda', version: 1 })
        .expect(409);

      expect(response.body.type).toBe('urn:lotou:problem:version-conflict');
    });

    it('aplica uma única edição quando duas chegam com a mesma versão', async () => {
      const show = await createShow(producer, showAt(venue));
      const responses = await Promise.all(
        ['A', 'B', 'C', 'D', 'E'].map((title) =>
          producer.patch(`/v1/shows/${show.id}`, { title, version: 1 }),
        ),
      );

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
      expect(responses.filter((r) => r.status === 409)).toHaveLength(4);
    });

    it('não deixa um show publicado ficar sem lote ou sem local', async () => {
      const show = await createPublishedShow(producer, showAt(venue));

      const withoutLots = await producer
        .patch(`/v1/shows/${show.id}`, {
          version: show.version,
          sectors: [{ sectorId: venue.sectors[0].id, lots: [] }],
        })
        .expect(422);
      expect(withoutLots.body.errors[0].field).toBe('sectors');

      const withoutVenue = await producer
        .patch(`/v1/shows/${show.id}`, { version: show.version, venueId: null })
        .expect(422);
      expect(
        withoutVenue.body.errors.map((e: { field: string }) => e.field),
      ).toContain('venueId');
    });

    it('revalida os setores quando o local muda', async () => {
      const show = await createShow(producer, showAt(venue));
      const otherVenue = await createVenue(producer, { name: 'Outro local' });

      const response = await producer
        .patch(`/v1/shows/${show.id}`, { version: 1, venueId: otherVenue.id })
        .expect(422);
      expect(response.body.errors[0].field).toBe('sectors.0.sectorId');

      const moved = await producer
        .patch(`/v1/shows/${show.id}`, {
          version: 1,
          venueId: otherVenue.id,
          sectors: [
            {
              sectorId: otherVenue.sectors[0].id,
              lots: [{ name: 'Lote único', priceCents: 9_000, quantity: 100 }],
            },
          ],
        })
        .expect(200);
      expect(moved.body.venue.id).toBe(otherVenue.id);
    });
  });
});

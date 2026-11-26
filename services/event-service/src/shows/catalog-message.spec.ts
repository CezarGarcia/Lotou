import {
  contractErrors,
  contractExample,
} from '../../test/support/contracts.js';
import { newId } from '../common/ids/id.js';
import { catalogMessage, toCatalogSnapshot } from './catalog-message.js';
import type { Show } from './show.schema.js';

const show = (overrides: Partial<Show> = {}): Show => ({
  _id: newId(),
  producerId: 'b1c2d3e4-0000-4000-8000-000000000001',
  title: 'Turnê Horizonte',
  artist: 'Marina Céu',
  artistSearch: 'marina ceu',
  description: 'Show de lançamento.',
  status: 'PUBLISHED',
  startsAt: new Date('2027-03-20T23:00:00Z'),
  startsOn: '2027-03-20',
  doorsOpenAt: new Date('2027-03-20T21:30:00Z'),
  salesStartAt: new Date('2027-01-10T15:00:00Z'),
  salesEndAt: new Date('2027-03-20T21:00:00Z'),
  highDemand: true,
  venue: {
    id: newId(),
    name: 'Arena Lotou',
    city: 'São Paulo',
    state: 'SP',
    timezone: 'America/Sao_Paulo',
    citySearch: 'sao paulo',
  },
  sectors: [
    {
      id: newId(),
      name: 'Pista',
      kind: 'GENERAL_ADMISSION',
      capacity: 2000,
      rows: [],
      lots: [
        {
          id: newId(),
          name: '1º lote',
          priceCents: 12_000,
          quantity: 1000,
          opensAt: null,
        },
        {
          id: newId(),
          name: '2º lote',
          priceCents: 16_000,
          quantity: 1000,
          opensAt: new Date('2027-02-01T15:00:00Z'),
        },
      ],
    },
    {
      id: newId(),
      name: 'Cadeira',
      kind: 'RESERVED_SEATING',
      capacity: 100,
      rows: [
        { label: 'A', seatCount: 50 },
        { label: 'B', seatCount: 50 },
      ],
      lots: [
        {
          id: newId(),
          name: 'Lote único',
          priceCents: 20_000,
          quantity: 100,
          opensAt: null,
        },
      ],
    },
  ],
  publishedAt: new Date('2027-01-05T12:00:00Z'),
  version: 2,
  createdAt: new Date('2027-01-05T11:00:00Z'),
  updatedAt: new Date('2027-01-05T12:00:00.123Z'),
  ...overrides,
});

describe('mensagens de shows.catalog', () => {
  it.each(['ShowPublished', 'ShowUpdated'] as const)(
    '%s segue o contrato',
    (type) => {
      const message = catalogMessage(type, show());
      expect(
        contractErrors('shows.catalog', type, JSON.parse(message.value)),
      ).toEqual([]);
    },
  );

  it.each([
    'PUBLISHED',
    'ON_SALE',
    'SALES_CLOSED',
    'FINISHED',
    'CANCELLED',
  ] as const)(
    'um show em %s segue o contrato, com as datas opcionais vazias',
    (status) => {
      const message = catalogMessage(
        'ShowUpdated',
        show({
          status,
          doorsOpenAt: null,
          salesStartAt: null,
          salesEndAt: null,
        }),
      );
      expect(
        contractErrors(
          'shows.catalog',
          'ShowUpdated',
          JSON.parse(message.value),
        ),
      ).toEqual([]);
    },
  );

  it('o exemplo do contrato passa no próprio schema (o teste valida de verdade)', () => {
    const example = contractExample('shows.catalog', 'ShowUpdated');
    expect(contractErrors('shows.catalog', 'ShowUpdated', example)).toEqual([]);
    expect(
      contractErrors('shows.catalog', 'ShowUpdated', {
        ...example,
        payload: { ...(example.payload as object), priceCents: 1.5 },
      }),
    ).not.toEqual([]);
  });

  it('chave, versão e envelope saem do show', () => {
    const current = show();
    const message = catalogMessage('ShowUpdated', current);
    const value = JSON.parse(message.value);

    expect(message).toMatchObject({
      topic: 'shows.catalog',
      key: current._id,
      aggregateVersion: 2,
      type: 'ShowUpdated',
      eventId: value.eventId,
    });
    expect(value).toMatchObject({
      type: 'ShowUpdated',
      version: 1,
      occurredAt: '2027-01-05T12:00:00.123Z',
      payload: { showId: current._id, version: 2 },
    });
    // UUID v7, como todo ID do Lotou.
    expect(value.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  });

  it('cada mensagem tem um eventId novo', () => {
    const current = show();
    expect(catalogMessage('ShowUpdated', current).eventId).not.toBe(
      catalogMessage('ShowUpdated', current).eventId,
    );
  });

  it('leva o show inteiro, com datas em UTC e preço em centavos', () => {
    const current = show();
    const snapshot = toCatalogSnapshot(current);

    expect(snapshot).toMatchObject({
      status: 'PUBLISHED',
      startsAt: '2027-03-20T23:00:00.000Z',
      doorsOpenAt: '2027-03-20T21:30:00.000Z',
      highDemand: true,
      venue: {
        id: current.venue!.id,
        name: 'Arena Lotou',
        city: 'São Paulo',
        state: 'SP',
        timezone: 'America/Sao_Paulo',
      },
    });
    expect(snapshot.sectors[0].lots).toEqual([
      expect.objectContaining({ priceCents: 12_000, opensAt: null }),
      expect.objectContaining({
        priceCents: 16_000,
        opensAt: '2027-02-01T15:00:00.000Z',
      }),
    ]);
    expect(snapshot.sectors[1].rows).toEqual([
      { label: 'A', seatCount: 50 },
      { label: 'B', seatCount: 50 },
    ]);
  });

  it('não leva o que é só do event-service', () => {
    const snapshot = toCatalogSnapshot(show()) as unknown as Record<
      string,
      unknown
    >;
    for (const field of [
      'description',
      'artistSearch',
      'startsOn',
      'publishedAt',
      'createdAt',
    ]) {
      expect(snapshot).not.toHaveProperty(field);
    }
    expect(snapshot.venue).not.toHaveProperty('citySearch');
  });

  it('rascunho nunca vira mensagem', () => {
    expect(() =>
      catalogMessage('ShowUpdated', show({ status: 'DRAFT' })),
    ).toThrow(/Rascunho/);
  });
});

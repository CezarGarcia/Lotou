import type { ApiClient } from './app.js';

export const arena = {
  name: 'Arena Lotou',
  address: { street: 'Av. das Nações, 1000', city: 'São Paulo', state: 'SP' },
  timezone: 'America/Sao_Paulo',
  sectors: [
    { name: 'Pista', kind: 'GENERAL_ADMISSION', capacity: 2000 },
    { name: 'Cadeira inferior', kind: 'RESERVED_SEATING', capacity: 500 },
  ],
};

export interface VenueBody {
  id: string;
  version: number;
  sectors: { id: string; name: string; capacity: number }[];
}

export interface ShowBody {
  id: string;
  status: string;
  version: number;
  sectors: { id: string; lots: { id: string; name: string }[] }[];
}

/** Daqui a `days` dias, às 23h UTC (20h em São Paulo). */
export function daysFromNow(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(23, 0, 0, 0);
  return date.toISOString();
}

export async function createVenue(
  producer: ApiClient,
  overrides: object = {},
): Promise<VenueBody> {
  const response = await producer
    .post('/v1/venues', { ...arena, ...overrides })
    .expect(201);
  return response.body as VenueBody;
}

/** Um show pronto para publicar: local, um setor e um lote. */
export function showAt(venue: VenueBody, overrides: object = {}) {
  return {
    title: 'Turnê Horizonte',
    artist: 'Marina Céu',
    description: 'Show de lançamento do álbum Horizonte.',
    startsAt: daysFromNow(60),
    venueId: venue.id,
    sectors: [
      {
        sectorId: venue.sectors[0].id,
        lots: [
          { name: '1º lote', priceCents: 12_000, quantity: 1000 },
          { name: '2º lote', priceCents: 16_000, quantity: 1000 },
        ],
      },
    ],
    ...overrides,
  };
}

export async function createShow(
  producer: ApiClient,
  body: object,
): Promise<ShowBody> {
  const response = await producer.post('/v1/shows', body).expect(201);
  return response.body as ShowBody;
}

export async function createPublishedShow(
  producer: ApiClient,
  body: object,
): Promise<ShowBody> {
  const show = await createShow(producer, body);
  const response = await producer
    .post(`/v1/shows/${show.id}/publish`, {}, null)
    .expect(200);
  return response.body as ShowBody;
}

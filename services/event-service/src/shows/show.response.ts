import type { SectorKind } from '../venues/sector-kind.js';
import type { ShowStatus } from './show-status.js';
import type { Show } from './show.schema.js';

export interface ShowVenueResponse {
  id: string;
  name: string;
  city: string;
  state: string;
  /** Fuso IANA em que as datas do show devem ser exibidas. */
  timezone: string;
}

/** O que a busca devolve: o suficiente para um card da loja. */
export interface ShowSummaryResponse {
  id: string;
  title: string;
  artist: string;
  status: ShowStatus;
  startsAt: Date;
  salesStartAt: Date | null;
  highDemand: boolean;
  venue: ShowVenueResponse | null;
  /** Menor preço entre os lotes, em centavos; `null` sem lotes. */
  priceFromCents: number | null;
}

export interface ShowResponse extends ShowSummaryResponse {
  description: string;
  doorsOpenAt: Date | null;
  salesEndAt: Date | null;
  sectors: {
    id: string;
    name: string;
    kind: SectorKind;
    capacity: number;
    lots: {
      id: string;
      name: string;
      priceCents: number;
      quantity: number;
      opensAt: Date | null;
    }[];
  }[];
  publishedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

const priceFrom = (show: Show): number | null => {
  const prices = show.sectors.flatMap((sector) =>
    sector.lots.map((lot) => lot.priceCents),
  );
  return prices.length > 0 ? Math.min(...prices) : null;
};

/** O contrato da API é montado campo a campo: nada do banco vaza por acaso. */
export function toShowSummary(show: Show): ShowSummaryResponse {
  return {
    id: show._id,
    title: show.title,
    artist: show.artist,
    status: show.status,
    startsAt: show.startsAt,
    salesStartAt: show.salesStartAt,
    highDemand: show.highDemand,
    venue: show.venue && {
      id: show.venue.id,
      name: show.venue.name,
      city: show.venue.city,
      state: show.venue.state,
      timezone: show.venue.timezone,
    },
    priceFromCents: priceFrom(show),
  };
}

export function toShowResponse(show: Show): ShowResponse {
  return {
    ...toShowSummary(show),
    description: show.description,
    doorsOpenAt: show.doorsOpenAt,
    salesEndAt: show.salesEndAt,
    sectors: show.sectors.map((sector) => ({
      id: sector.id,
      name: sector.name,
      kind: sector.kind,
      capacity: sector.capacity,
      lots: sector.lots.map((lot) => ({
        id: lot.id,
        name: lot.name,
        priceCents: lot.priceCents,
        quantity: lot.quantity,
        opensAt: lot.opensAt,
      })),
    })),
    publishedAt: show.publishedAt,
    version: show.version,
    createdAt: show.createdAt,
    updatedAt: show.updatedAt,
  };
}

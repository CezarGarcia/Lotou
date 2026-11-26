/** Contrato da API de shows (event-service, via gateway). */

export type ShowStatus =
  'DRAFT' | 'PUBLISHED' | 'ON_SALE' | 'SALES_CLOSED' | 'FINISHED' | 'CANCELLED';

export type SectorKind = 'GENERAL_ADMISSION' | 'RESERVED_SEATING';

export interface ShowVenue {
  id: string;
  name: string;
  city: string;
  state: string;
  /** Fuso IANA do local: as datas do show são exibidas nele. */
  timezone: string;
}

/** O que a busca devolve: o suficiente para um card. */
export interface ShowSummary {
  id: string;
  title: string;
  artist: string;
  status: ShowStatus;
  /** Datas em ISO 8601, UTC. */
  startsAt: string;
  salesStartAt: string | null;
  highDemand: boolean;
  venue: ShowVenue | null;
  /** Menor preço entre os lotes, em centavos. */
  priceFromCents: number | null;
}

export interface Lot {
  id: string;
  name: string;
  /** Preço em centavos, inteiro. */
  priceCents: number;
  quantity: number;
  opensAt: string | null;
}

export interface Sector {
  id: string;
  name: string;
  kind: SectorKind;
  capacity: number;
  lots: Lot[];
}

export interface Show extends ShowSummary {
  description: string;
  doorsOpenAt: string | null;
  salesEndAt: string | null;
  sectors: Sector[];
}

/** Página de uma listagem paginada por cursor. */
export interface Page<T> {
  items: T[];
  /** Devolvido em `cursor` para ler a próxima página; `null` na última. */
  nextCursor: string | null;
}

export interface ShowFilters {
  artist: string;
  city: string;
  /** Dias no formato AAAA-MM-DD. */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: ShowFilters = { artist: '', city: '', from: '', to: '' };

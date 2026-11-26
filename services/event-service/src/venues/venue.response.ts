import type { SectorKind } from './sector-kind.js';
import type { Venue } from './venue.schema.js';

export interface VenueResponse {
  id: string;
  name: string;
  address: { street?: string; city: string; state: string };
  timezone: string;
  sectors: {
    id: string;
    name: string;
    kind: SectorKind;
    capacity: number;
    /** Fileiras de um setor de cadeira numerada; vazio na pista. */
    rows: { label: string; seatCount: number }[];
  }[];
  /** Soma das capacidades dos setores. */
  capacity: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** O contrato da API é montado campo a campo: nada do banco vaza por acaso. */
export function toVenueResponse(venue: Venue): VenueResponse {
  return {
    id: venue._id,
    name: venue.name,
    address: {
      ...(venue.address.street && { street: venue.address.street }),
      city: venue.address.city,
      state: venue.address.state,
    },
    timezone: venue.timezone,
    sectors: venue.sectors.map(({ id, name, kind, capacity, rows }) => ({
      id,
      name,
      kind,
      capacity,
      rows: (rows ?? []).map(({ label, seatCount }) => ({ label, seatCount })),
    })),
    capacity: venue.sectors.reduce((sum, s) => sum + s.capacity, 0),
    version: venue.version,
    createdAt: venue.createdAt,
    updatedAt: venue.updatedAt,
  };
}

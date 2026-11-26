import { envelope } from '../kafka/envelope.js';
import { TOPICS } from '../kafka/kafka.js';
import type { OutgoingMessage } from '../outbox/outbox.js';
import type { SectorKind } from '../venues/sector-kind.js';
import type { ShowStatus } from './show-status.js';
import type { Show } from './show.schema.js';

/**
 * Tipos de `shows.catalog`: `ShowPublished` quando o show sai do rascunho e
 * `ShowUpdated` em toda mudança depois disso (edição, abertura e
 * encerramento das vendas, mudança no local).
 */
export type CatalogEventType = 'ShowPublished' | 'ShowUpdated';

/** Versão do payload dos dois tipos (contracts/shows.catalog/*.v1). */
const PAYLOAD_VERSION = 1;

/**
 * O show inteiro, como os outros serviços o recebem
 * (`contracts/shows.catalog/ShowUpdated.v1.schema.json`). Datas em ISO 8601
 * UTC e dinheiro em centavos.
 */
export interface CatalogSnapshot {
  showId: string;
  /** Sobe a cada mudança: o consumidor guarda a mais alta e ignora as outras. */
  version: number;
  producerId: string;
  status: Exclude<ShowStatus, 'DRAFT'>;
  title: string;
  artist: string;
  startsAt: string;
  doorsOpenAt: string | null;
  salesStartAt: string | null;
  salesEndAt: string | null;
  highDemand: boolean;
  venue: {
    id: string;
    name: string;
    city: string;
    state: string;
    timezone: string;
  };
  sectors: {
    id: string;
    name: string;
    kind: SectorKind;
    capacity: number;
    rows: { label: string; seatCount: number }[];
    lots: {
      id: string;
      name: string;
      priceCents: number;
      quantity: number;
      opensAt: string | null;
    }[];
  }[];
  updatedAt: string;
}

const iso = (date: Date | null): string | null => date && date.toISOString();

/**
 * Monta o snapshot campo a campo: nada do banco vaza por acaso (a descrição,
 * os campos de busca e o `publishedAt` ficam de fora). Rascunho nunca sai do
 * serviço.
 */
export function toCatalogSnapshot(show: Show): CatalogSnapshot {
  const { status, venue } = show;
  if (status === 'DRAFT') {
    throw new Error(`Rascunho não vai para o catálogo: ${show._id}`);
  }
  if (!venue) {
    // Publicar exige local, e o local não pode ser removido depois.
    throw new Error(`Show publicado sem local: ${show._id}`);
  }
  return {
    showId: show._id,
    version: show.version,
    producerId: show.producerId,
    status,
    title: show.title,
    artist: show.artist,
    startsAt: show.startsAt.toISOString(),
    doorsOpenAt: iso(show.doorsOpenAt),
    salesStartAt: iso(show.salesStartAt),
    salesEndAt: iso(show.salesEndAt),
    highDemand: show.highDemand,
    venue: {
      id: venue.id,
      name: venue.name,
      city: venue.city,
      state: venue.state,
      timezone: venue.timezone,
    },
    sectors: show.sectors.map((sector) => ({
      id: sector.id,
      name: sector.name,
      kind: sector.kind,
      capacity: sector.capacity,
      rows: (sector.rows ?? []).map(({ label, seatCount }) => ({
        label,
        seatCount,
      })),
      lots: sector.lots.map((lot) => ({
        id: lot.id,
        name: lot.name,
        priceCents: lot.priceCents,
        quantity: lot.quantity,
        opensAt: iso(lot.opensAt),
      })),
    })),
    updatedAt: show.updatedAt.toISOString(),
  };
}

/** A mensagem de `shows.catalog` para o show como está agora. */
export function catalogMessage(
  type: CatalogEventType,
  show: Show,
): OutgoingMessage {
  const message = envelope(
    type,
    PAYLOAD_VERSION,
    show.updatedAt,
    toCatalogSnapshot(show),
  );
  return {
    eventId: message.eventId,
    topic: TOPICS.catalog,
    key: show._id,
    aggregateVersion: show.version,
    type,
    value: JSON.stringify(message),
  };
}

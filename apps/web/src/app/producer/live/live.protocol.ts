/**
 * Protocolo do WebSocket do painel ao vivo, conforme `contracts/realtime-dashboard.md`.
 *
 * O servidor é outro serviço: tudo o que chega é conferido antes de virar
 * estado. Um frame que não é JSON, de tipo desconhecido ou com campos faltando
 * é ignorado, sem derrubar a conexão.
 */

/** Situação de um lote no inventory. */
export type LotStatus = 'SCHEDULED' | 'ON_SALE' | 'SOLD_OUT' | 'PAUSED' | 'CLOSED';

export interface LiveLot {
  lotId: string;
  name: string;
  priceCents: number;
  status: LotStatus | string;
}

export interface SectorMetrics {
  sectorId: string;
  name: string;
  capacity: number;
  sold: number;
  /** Capacidade menos vendidos; reservas seguradas não contam. */
  remaining: number;
  /** `null` antes da abertura. */
  currentLot: LiveLot | null;
}

export interface LiveMetrics {
  /** Quando o analytics calculou as métricas (UTC). */
  at: string;
  ticketsSold: number;
  revenueCents: number;
  ordersConfirmed: number;
  ordersCancelled: number;
  ordersLastMinute: number;
  sectors: SectorMetrics[];
}

interface EntryBase {
  /** ID da entrada no Redis Stream (`1764180001000-0`): dá a ordem do feed. */
  id: string;
  eventId: string;
  /** `occurredAt` do fato (UTC). */
  at: string;
}

export interface OrderConfirmedEntry extends EntryBase {
  type: 'OrderConfirmed';
  orderId: string;
  sectorName: string;
  quantity: number;
  totalCents: number;
}

export interface OrderCancelledEntry extends EntryBase {
  type: 'OrderCancelled';
  orderId: string;
  reason: string;
  totalCents: number;
}

/**
 * Nas viradas de lote, setor e lote vêm do catálogo e são `null` no caso raro
 * de o lote chegar ao analytics antes do show.
 */
export interface LotOpenedEntry extends EntryBase {
  type: 'LotOpened';
  sectorName: string | null;
  lotName: string | null;
  priceCents: number;
}

export interface LotSoldOutEntry extends EntryBase {
  type: 'LotSoldOut';
  sectorName: string | null;
  lotName: string | null;
}

export type ActivityEntry =
  OrderConfirmedEntry | OrderCancelledEntry | LotOpenedEntry | LotSoldOutEntry;

export type ServerMessage =
  | { type: 'ready'; user: string }
  | { type: 'snapshot'; showId: string; metrics: LiveMetrics; activity: ActivityEntry[] }
  | { type: 'metrics'; showId: string; metrics: LiveMetrics }
  | { type: 'activity'; showId: string; entry: ActivityEntry }
  | { type: 'error'; code: string; detail: string; showId?: string };

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; showId: string }
  | { type: 'unsubscribe'; showId: string };

/** Códigos de fechamento do servidor. */
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_FORBIDDEN = 4403;
export const CLOSE_AUTH_TIMEOUT = 4408;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isTextOrNull = (value: unknown): value is string | null => value === null || isText(value);
const isInstant = (value: unknown): value is string =>
  isText(value) && !Number.isNaN(Date.parse(value));

function parseLot(value: unknown): LiveLot | null | undefined {
  if (value === null) {
    return null;
  }
  if (!isObject(value)) {
    return undefined;
  }
  const { lotId, name, priceCents, status } = value;
  return isText(lotId) && isText(name) && isCount(priceCents) && isText(status)
    ? { lotId, name, priceCents, status }
    : undefined;
}

function parseSector(value: unknown): SectorMetrics | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const { sectorId, name, capacity, sold, remaining } = value;
  const currentLot = parseLot(value['currentLot'] ?? null);
  return isText(sectorId) &&
    isText(name) &&
    isCount(capacity) &&
    isCount(sold) &&
    isCount(remaining) &&
    currentLot !== undefined
    ? { sectorId, name, capacity, sold, remaining, currentLot }
    : undefined;
}

export function parseMetrics(value: unknown): LiveMetrics | undefined {
  if (!isObject(value) || !Array.isArray(value['sectors'])) {
    return undefined;
  }
  const { at, ticketsSold, revenueCents, ordersConfirmed, ordersCancelled, ordersLastMinute } =
    value;
  const sectors = value['sectors'].map(parseSector);
  if (
    !isInstant(at) ||
    !isCount(ticketsSold) ||
    !isCount(revenueCents) ||
    !isCount(ordersConfirmed) ||
    !isCount(ordersCancelled) ||
    !isCount(ordersLastMinute) ||
    sectors.some((sector) => sector === undefined)
  ) {
    return undefined;
  }
  return {
    at,
    ticketsSold,
    revenueCents,
    ordersConfirmed,
    ordersCancelled,
    ordersLastMinute,
    sectors: sectors as SectorMetrics[],
  };
}

/** Uma entrada do feed, ou `undefined` se o tipo é desconhecido ou falta campo. */
export function parseEntry(value: unknown): ActivityEntry | undefined {
  if (!isObject(value) || !isText(value['id']) || !isInstant(value['at'])) {
    return undefined;
  }
  const base = {
    id: value['id'],
    eventId: typeof value['eventId'] === 'string' ? value['eventId'] : '',
    at: value['at'],
  };
  const { orderId, sectorName, lotName, quantity, totalCents, priceCents, reason } = value;
  switch (value['type']) {
    case 'OrderConfirmed':
      return isText(orderId) && isText(sectorName) && isCount(quantity) && isCount(totalCents)
        ? { ...base, type: 'OrderConfirmed', orderId, sectorName, quantity, totalCents }
        : undefined;
    case 'OrderCancelled':
      return isText(orderId) && isCount(totalCents)
        ? {
            ...base,
            type: 'OrderCancelled',
            orderId,
            reason: typeof reason === 'string' ? reason : '',
            totalCents,
          }
        : undefined;
    case 'LotOpened':
      return isTextOrNull(sectorName) && isTextOrNull(lotName) && isCount(priceCents)
        ? { ...base, type: 'LotOpened', sectorName, lotName, priceCents }
        : undefined;
    case 'LotSoldOut':
      return isTextOrNull(sectorName) && isTextOrNull(lotName)
        ? { ...base, type: 'LotSoldOut', sectorName, lotName }
        : undefined;
    default:
      return undefined;
  }
}

/** Lê um frame de texto do servidor. `null` quando ele não segue o protocolo. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') {
    return null;
  }
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(message)) {
    return null;
  }
  const showId = message['showId'];
  switch (message['type']) {
    case 'ready':
      return { type: 'ready', user: typeof message['user'] === 'string' ? message['user'] : '' };
    case 'snapshot': {
      const metrics = parseMetrics(message['metrics']);
      const activity = message['activity'];
      if (!isText(showId) || !metrics || !Array.isArray(activity)) {
        return null;
      }
      // Um tipo de entrada que o painel ainda não conhece não invalida a foto inteira.
      const entries = activity
        .map(parseEntry)
        .filter((entry): entry is ActivityEntry => entry !== undefined);
      return { type: 'snapshot', showId, metrics, activity: entries };
    }
    case 'metrics': {
      const metrics = parseMetrics(message['metrics']);
      return isText(showId) && metrics ? { type: 'metrics', showId, metrics } : null;
    }
    case 'activity': {
      const entry = parseEntry(message['entry']);
      return isText(showId) && entry ? { type: 'activity', showId, entry } : null;
    }
    case 'error': {
      const { code, detail } = message;
      return isText(code)
        ? {
            type: 'error',
            code,
            detail: typeof detail === 'string' ? detail : '',
            ...(isText(showId) ? { showId } : {}),
          }
        : null;
    }
    default:
      return null;
  }
}

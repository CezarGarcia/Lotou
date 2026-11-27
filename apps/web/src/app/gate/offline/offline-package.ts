import { utcToZonedLocal, zonedLocalToUtc } from '../../core/format/zoned-time';

export type OfflineTicketStatus = 'VALID' | 'USED' | 'CANCELLED';

/** Um ingresso do show no pacote offline. Sem dado pessoal: só o lugar e o estado. */
export interface OfflineTicket {
  id: string;
  sectorId: string;
  sectorName: string;
  seat: string | null;
  status: OfflineTicketStatus;
  /** Em `USED`: a primeira entrada (UTC) e o portão, quando o servidor sabe. */
  usedAt?: string;
  gate?: string;
}

/**
 * O que o leitor precisa para validar sem internet (`GET
 * /checkins/shows/{id}/offline-package`): a chave pública que confere o QR
 * (ADR 38), a regra da abertura dos portões e todos os ingressos do show.
 */
export interface OfflinePackage {
  showId: string;
  /** Quando o servidor montou a lista (UTC). */
  generatedAt: string;
  /** Chave pública Ed25519, SPKI DER em base64. */
  publicKey: string;
  doorsOpenAt: string | null;
  startsAt: string;
  timezone: string;
  tickets: OfflineTicket[];
}

/** Um setor do show, como o leitor mostra. */
export interface GateSector {
  id: string;
  name: string;
}

type Raw = Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const STATUSES: readonly string[] = ['VALID', 'USED', 'CANCELLED'];

function toTicket(raw: Raw): OfflineTicket | null {
  const id = text(raw['id']).toLowerCase();
  const status = text(raw['status']);
  if (!id || !STATUSES.includes(status)) {
    return null;
  }
  const ticket: OfflineTicket = {
    id,
    sectorId: text(raw['sectorId']),
    sectorName: text(raw['sectorName']),
    seat: text(raw['seat']) || null,
    status: status as OfflineTicketStatus,
  };
  if (status === 'USED') {
    const usedAt = text(raw['usedAt']);
    const gate = text(raw['gate']);
    if (usedAt) ticket.usedAt = usedAt;
    if (gate) ticket.gate = gate;
  }
  return ticket;
}

/**
 * Lê o pacote da API. Um pacote sem chave, sem show ou sem horário não serve
 * para validar nada: vira `null`, e o leitor fica com o que já tinha guardado.
 */
export function toOfflinePackage(raw: unknown): OfflinePackage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const body = raw as Raw;
  const showId = text(body['showId']);
  const publicKey = text(body['publicKey']);
  const startsAt = text(body['startsAt']);
  const generatedAt = text(body['generatedAt']);
  if (!showId || !publicKey || !startsAt || !generatedAt) {
    return null;
  }
  const tickets = Array.isArray(body['tickets']) ? (body['tickets'] as Raw[]) : [];
  return {
    showId,
    generatedAt,
    publicKey,
    doorsOpenAt: text(body['doorsOpenAt']) || null,
    startsAt,
    timezone: text(body['timezone']) || 'America/Sao_Paulo',
    tickets: tickets
      .filter((item) => typeof item === 'object' && item !== null)
      .map(toTicket)
      .filter((ticket) => ticket !== null),
  };
}

/**
 * Quando a portaria passa a aceitar ingressos: a mesma regra do
 * checkin-service (`doors.ts`). É o `doorsOpenAt` do show; sem ele, o começo
 * do dia do show no fuso do local, nunca a véspera.
 */
export function doorsOpenAtOf(pkg: Pick<OfflinePackage, 'doorsOpenAt' | 'startsAt' | 'timezone'>) {
  if (pkg.doorsOpenAt) {
    return pkg.doorsOpenAt;
  }
  const day = utcToZonedLocal(pkg.startsAt, pkg.timezone).slice(0, 10);
  return zonedLocalToUtc(`${day}T00:00`, pkg.timezone) ?? pkg.startsAt;
}

/** Os setores que aparecem no pacote, em ordem alfabética. */
export function sectorsOf(pkg: OfflinePackage | null): GateSector[] {
  const sectors = new Map<string, string>();
  for (const ticket of pkg?.tickets ?? []) {
    if (ticket.sectorId && !sectors.has(ticket.sectorId)) {
      sectors.set(ticket.sectorId, ticket.sectorName);
    }
  }
  return [...sectors]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

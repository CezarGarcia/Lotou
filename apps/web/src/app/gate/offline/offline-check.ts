import { CheckinResponse } from '../data/checkin.api';
import { OfflineTicket } from './offline-package';
import { TicketCode } from './ticket-code';

/** Uma entrada que este aparelho conhece: lida aqui (com ou sem internet) ou confirmada no envio. */
export interface LocalEntry {
  showId: string;
  ticketId: string;
  /** UTC. */
  at: string;
  gate: string;
}

export interface OfflineCheck {
  /** O QR lido; `null` se não é um código do Lotou. */
  code: TicketCode | null;
  /** Resultado da assinatura Ed25519 (`LOTOU2`); `null` quando não deu para conferir. */
  signatureValid: boolean | null;
  /** O ingresso no pacote do show, se estiver lá. */
  ticket: OfflineTicket | undefined;
  /** A entrada que este aparelho já registrou para o ingresso. */
  entry: LocalEntry | undefined;
  /** Setores que este portão atende; vazio, todos. */
  sectors: readonly string[];
  /** Abertura dos portões (UTC), pela regra de `doorsOpenAtOf`. */
  doorsOpenAt: string;
  now: number;
}

/**
 * A decisão do leitor sem internet, na ordem do checkin-service: o código, o
 * ingresso, o cancelamento, a primeira entrada, o setor do portão e a
 * abertura. Função pura: o pacote, as entradas do aparelho e o relógio
 * entram como parâmetros.
 *
 * - `LOTOU2` tem a assinatura conferida com a chave pública do pacote (ADR 38):
 *   quem só tem a pública não consegue criar ingresso.
 * - `LOTOU1` (HMAC, dos ingressos emitidos antes do ADR 38) não dá para
 *   conferir no aparelho, que não tem a chave secreta. Vale só se o ingresso
 *   estiver no pacote: o id é um UUID v7, com 74 bits aleatórios, que só quem
 *   tem o ingresso conhece.
 * - Sem a lista do servidor, outro show e "desconhecido" são a mesma coisa:
 *   o pacote só tem os ingressos deste show.
 */
export function checkOffline(input: OfflineCheck): CheckinResponse {
  const { code, signatureValid, ticket, entry, sectors, doorsOpenAt, now } = input;
  if (!code || (code.version === 2 && signatureValid === false)) {
    return { result: 'INVALID_CODE', ticket: null, firstEntry: null };
  }
  if (!ticket) {
    return { result: 'UNKNOWN_TICKET', ticket: null, firstEntry: null };
  }
  const known = { ticketId: ticket.id, sectorName: ticket.sectorName, seat: ticket.seat };
  if (ticket.status === 'CANCELLED') {
    return { result: 'CANCELLED', ticket: known, firstEntry: null };
  }
  if (ticket.status === 'USED' || entry) {
    return { result: 'ALREADY_USED', ticket: known, firstEntry: firstEntryOf(ticket, entry) };
  }
  if (sectors.length > 0 && !sectors.includes(ticket.sectorId)) {
    return { result: 'WRONG_SECTOR', ticket: known, firstEntry: null };
  }
  if (now < Date.parse(doorsOpenAt)) {
    return { result: 'NOT_OPEN', ticket: known, firstEntry: null };
  }
  return { result: 'ACCEPTED', ticket: known, firstEntry: null };
}

/** A primeira entrada conhecida: a do servidor (no pacote) ou a deste aparelho. */
function firstEntryOf(
  ticket: OfflineTicket,
  entry: LocalEntry | undefined,
): CheckinResponse['firstEntry'] {
  const candidates = [
    ticket.usedAt ? { at: ticket.usedAt, gate: ticket.gate ?? '' } : null,
    entry ? { at: entry.at, gate: entry.gate } : null,
  ].filter((item) => item !== null);
  candidates.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const first = candidates[0];
  return first?.gate ? first : null;
}

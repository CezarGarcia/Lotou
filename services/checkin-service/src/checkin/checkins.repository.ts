import type { Pool, PoolClient } from 'pg';
import type { Rejection } from '../messages/checkin-events.js';
import type { TicketStatus } from '../tickets/ticket-status.js';
import type { FirstEntry, ScannedTicket } from './checkin-result.js';

type Db = Pool | PoolClient;

interface ScannedTicketRow {
  ticket_id: string;
  order_id: string;
  show_id: string;
  sector_id: string;
  sector_name: string;
  seat: string | null;
  status: TicketStatus;
  starts_at: Date | null;
  doors_open_at: Date | null;
  timezone: string | null;
  checked_in_at: Date | null;
  gate: string | null;
}

/**
 * Tudo o que a leitura precisa, numa consulta só pela chave primária: o
 * ingresso, o horário do show e a entrada, se já houver.
 */
export async function findScannedTicket(
  db: Db,
  ticketId: string,
): Promise<ScannedTicket | undefined> {
  const {
    rows: [row],
  } = await db.query<ScannedTicketRow>(
    `SELECT t.ticket_id, t.order_id, t.show_id, t.sector_id, t.sector_name,
            t.seat, t.status, s.starts_at, s.doors_open_at, s.timezone,
            c.checked_in_at, c.gate
       FROM valid_tickets t
       LEFT JOIN shows s ON s.show_id = t.show_id
       LEFT JOIN checkins c ON c.ticket_id = t.ticket_id
      WHERE t.ticket_id = $1`,
    [ticketId],
  );
  if (!row) {
    return undefined;
  }
  return {
    ticketId: row.ticket_id,
    orderId: row.order_id,
    showId: row.show_id,
    sectorId: row.sector_id,
    sectorName: row.sector_name,
    seat: row.seat,
    status: row.status,
    show:
      row.starts_at && row.timezone
        ? {
            startsAt: row.starts_at,
            doorsOpenAt: row.doors_open_at,
            timezone: row.timezone,
          }
        : null,
    entry:
      row.checked_in_at && row.gate
        ? { at: row.checked_in_at, gate: row.gate }
        : null,
  };
}

/**
 * Grava a entrada. A constraint única em `ticket_id` decide: devolve `false`
 * se outra transação já gravou a entrada deste ingresso (e, se ela ainda não
 * terminou, espera o fim dela antes de responder).
 */
export async function insertCheckin(
  db: PoolClient,
  checkin: { id: string; ticketId: string; showId: string } & FirstEntry,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO checkins (id, ticket_id, show_id, gate, checked_in_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ticket_id) DO NOTHING`,
    [checkin.id, checkin.ticketId, checkin.showId, checkin.gate, checkin.at],
  );
  return rowCount === 1;
}

/**
 * `VALID` → `USED` (ticket-status.ts). Devolve `false` se o ingresso não está
 * mais `VALID`: um `TicketsCancelled` chegou entre a consulta e a gravação.
 */
export async function markUsed(
  db: PoolClient,
  ticketId: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE valid_tickets SET status = 'USED', updated_at = now()
      WHERE ticket_id = $1 AND status = 'VALID'`,
    [ticketId],
  );
  return rowCount === 1;
}

export async function findEntry(
  db: Db,
  ticketId: string,
): Promise<FirstEntry | undefined> {
  const {
    rows: [row],
  } = await db.query<{ checked_in_at: Date; gate: string }>(
    'SELECT checked_in_at, gate FROM checkins WHERE ticket_id = $1',
    [ticketId],
  );
  return row && { at: row.checked_in_at, gate: row.gate };
}

/** Grava um lote de recusas, na transação de quem chama. */
export async function insertRejections(
  db: PoolClient,
  rejections: Rejection[],
): Promise<void> {
  await db.query(
    `INSERT INTO checkin_rejections (id, show_id, gate, reason, ticket_id, rejected_at)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[],
                          $5::uuid[], $6::timestamptz[])
     ON CONFLICT (id) DO NOTHING`,
    [
      rejections.map((r) => r.id),
      rejections.map((r) => r.showId),
      rejections.map((r) => r.gate),
      rejections.map((r) => r.reason),
      rejections.map((r) => r.ticketId),
      rejections.map((r) => r.rejectedAt),
    ],
  );
}

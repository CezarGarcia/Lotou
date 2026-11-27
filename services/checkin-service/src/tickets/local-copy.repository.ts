import type { Pool, PoolClient } from 'pg';
import type {
  CancelReason,
  CatalogShow,
  TicketsIssued,
} from '../messages/incoming.js';
import type { TicketStatus } from './ticket-status.js';

type Db = Pool | PoolClient;

/**
 * Registra o `eventId` como processado. Devolve `false` se ele já estava lá:
 * a mensagem é repetida e o efeito já foi gravado.
 */
export async function markProcessed(
  db: Db,
  eventId: string,
  type: string,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO processed_events (event_id, type) VALUES ($1, $2)
     ON CONFLICT (event_id) DO NOTHING`,
    [eventId, type],
  );
  return rowCount === 1;
}

/**
 * Grava os ingressos emitidos como `VALID`. Um ingresso que já existe fica
 * como está: nem um `TicketsIssued` atrasado ressuscita um ingresso cancelado
 * ou usado. Devolve quantos entraram.
 */
export async function insertIssuedTickets(
  db: Db,
  { payload }: TicketsIssued,
): Promise<number> {
  const { rowCount } = await db.query(
    `INSERT INTO valid_tickets
       (ticket_id, order_id, show_id, sector_id, sector_name, seat, status, issued_at)
     SELECT t.ticket_id, $1, $2, t.sector_id, t.sector_name, t.seat, 'VALID', $3
       FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::text[])
         AS t (ticket_id, sector_id, sector_name, seat)
     ON CONFLICT (ticket_id) DO NOTHING`,
    [
      payload.orderId,
      payload.showId,
      payload.issuedAt,
      payload.tickets.map((t) => t.ticketId),
      payload.tickets.map((t) => t.sectorId),
      payload.tickets.map((t) => t.sectorName),
      payload.tickets.map((t) => t.seat),
    ],
  );
  return rowCount ?? 0;
}

/** O estado atual dos ingressos, travados até o fim da transação. */
export async function lockTickets(
  db: PoolClient,
  ticketIds: string[],
): Promise<Map<string, TicketStatus>> {
  // Em ordem de ID: duas transações que travam os mesmos ingressos não se
  // esperam em ciclo.
  const { rows } = await db.query<{ ticket_id: string; status: TicketStatus }>(
    `SELECT ticket_id, status FROM valid_tickets
      WHERE ticket_id = ANY($1::uuid[])
      ORDER BY ticket_id
        FOR UPDATE`,
    [ticketIds],
  );
  return new Map(rows.map((row) => [row.ticket_id, row.status]));
}

export async function cancelTickets(
  db: PoolClient,
  ticketIds: string[],
  reason: CancelReason,
  cancelledAt: string,
): Promise<void> {
  await db.query(
    `UPDATE valid_tickets
        SET status = 'CANCELLED', cancelled_at = $2, cancel_reason = $3,
            updated_at = now()
      WHERE ticket_id = ANY($1::uuid[]) AND status = 'VALID'`,
    [ticketIds, cancelledAt, reason],
  );
}

/**
 * Grava o show se a versão for mais alta que a guardada. Devolve `false` se a
 * mensagem é de uma versão igual ou anterior (repetida, ou fora de ordem
 * depois de um replay): nada muda.
 */
export async function upsertShow(
  db: Db,
  { payload }: CatalogShow,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO shows (show_id, version, producer_id, status, title, artist,
                        starts_at, doors_open_at, venue_name, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (show_id) DO UPDATE
        SET version = EXCLUDED.version,
            producer_id = EXCLUDED.producer_id,
            status = EXCLUDED.status,
            title = EXCLUDED.title,
            artist = EXCLUDED.artist,
            starts_at = EXCLUDED.starts_at,
            doors_open_at = EXCLUDED.doors_open_at,
            venue_name = EXCLUDED.venue_name,
            timezone = EXCLUDED.timezone,
            updated_at = now()
      WHERE shows.version < EXCLUDED.version`,
    [
      payload.showId,
      payload.version,
      payload.producerId,
      payload.status,
      payload.title,
      payload.artist,
      payload.startsAt,
      payload.doorsOpenAt,
      payload.venue.name,
      payload.venue.timezone,
    ],
  );
  return rowCount === 1;
}

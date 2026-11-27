import type { Pool, PoolClient } from 'pg';
import type { TicketStatus } from '../tickets/ticket-status.js';
import type { FirstEntry } from './checkin-result.js';
import type {
  ConflictKind,
  OfflineOutcome,
  OfflineRejection,
  StoredOfflineScan,
} from './offline-scan.js';

type Db = Pool | PoolClient;

/** Uma leitura offline, como fica em `offline_scans` (auditoria e idempotência). */
export interface OfflineScanRow {
  id: string;
  showId: string;
  gate: string;
  deviceId: string;
  /** Nulo quando o código não passou na assinatura: o ID nele não é confiável. */
  ticketId: string | null;
  scannedAt: Date;
  outcome: OfflineOutcome;
  kind: ConflictKind | null;
  reason: OfflineRejection | null;
}

/**
 * Grava a leitura. Devolve `false` se ela já estava gravada: o mesmo envio
 * repetido (o aparelho não recebeu a resposta e mandou de novo), talvez ao
 * mesmo tempo. Quem chama desfaz a transação e responde o que foi gravado.
 */
export async function insertOfflineScan(
  db: PoolClient,
  scan: OfflineScanRow,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO offline_scans (id, show_id, gate, device_id, ticket_id,
                                scanned_at, outcome, kind, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      scan.id,
      scan.showId,
      scan.gate,
      scan.deviceId,
      scan.ticketId,
      scan.scannedAt,
      scan.outcome,
      scan.kind,
      scan.reason,
    ],
  );
  return rowCount === 1;
}

/**
 * Registra o conflito da leitura (a chave é a própria leitura), com a entrada
 * que valeu quando é uma entrada dupla.
 */
export async function insertOfflineConflict(
  db: PoolClient,
  scan: OfflineScanRow & { ticketId: string; kind: ConflictKind },
  firstEntry: FirstEntry | null,
): Promise<void> {
  await db.query(
    `INSERT INTO offline_conflicts (id, show_id, ticket_id, gate, device_id,
                                    scanned_at, kind, first_gate, first_checked_in_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      scan.id,
      scan.showId,
      scan.ticketId,
      scan.gate,
      scan.deviceId,
      scan.scannedAt,
      scan.kind,
      firstEntry?.gate ?? null,
      firstEntry?.at ?? null,
    ],
  );
}

interface StoredRow {
  id: string;
  outcome: OfflineOutcome;
  kind: ConflictKind | null;
  reason: OfflineRejection | null;
  first_gate: string | null;
  first_checked_in_at: Date | null;
}

/** As leituras já gravadas entre as informadas, com o resultado de cada uma. */
export async function findOfflineScans(
  db: Db,
  ids: string[],
): Promise<Map<string, StoredOfflineScan>> {
  const { rows } = await db.query<StoredRow>(
    `SELECT s.id, s.outcome, s.kind, s.reason, c.first_gate, c.first_checked_in_at
       FROM offline_scans s
       LEFT JOIN offline_conflicts c ON c.id = s.id
      WHERE s.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        outcome: row.outcome,
        kind: row.kind,
        reason: row.reason,
        firstEntry:
          row.first_gate && row.first_checked_in_at
            ? { gate: row.first_gate, at: row.first_checked_in_at }
            : null,
      },
    ]),
  );
}

export interface PackageShowRow {
  show_id: string;
  starts_at: Date;
  doors_open_at: Date | null;
  timezone: string;
}

export async function findPackageShow(
  db: Db,
  showId: string,
): Promise<PackageShowRow | undefined> {
  const {
    rows: [row],
  } = await db.query<PackageShowRow>(
    `SELECT show_id, starts_at, doors_open_at, timezone
       FROM shows WHERE show_id = $1`,
    [showId],
  );
  return row;
}

export interface PackageTicketRow {
  ticket_id: string;
  sector_id: string;
  sector_name: string;
  seat: string | null;
  status: TicketStatus;
  checked_in_at: Date | null;
  gate: string | null;
}

/**
 * Todos os ingressos do show, com a entrada de quem já entrou. Sem pedido nem
 * comprador: o pacote vai para o aparelho do portão.
 */
export async function findPackageTickets(
  db: Db,
  showId: string,
): Promise<PackageTicketRow[]> {
  const { rows } = await db.query<PackageTicketRow>(
    `SELECT t.ticket_id, t.sector_id, t.sector_name, t.seat, t.status,
            c.checked_in_at, c.gate
       FROM valid_tickets t
       LEFT JOIN checkins c ON c.ticket_id = t.ticket_id
      WHERE t.show_id = $1
      ORDER BY t.ticket_id`,
    [showId],
  );
  return rows;
}

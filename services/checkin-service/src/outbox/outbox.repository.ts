import type { PoolClient } from 'pg';
import type { TraceHeaders } from '../kafka/trace-headers.js';
import type { Envelope } from '../messages/checkin-events.js';

export interface OutboxMessage {
  topic: string;
  key: string;
  event: Envelope<string, unknown>;
  /** Trace da leitura que causou o evento; o relay o leva ao Kafka. */
  headers: TraceHeaders;
}

export interface OutboxRow {
  id: string;
  topic: string;
  message_key: string;
  type: string;
  payload: unknown;
  headers: TraceHeaders;
}

/** Grava as mensagens no outbox, na ordem, na transação de quem chama. */
export async function enqueue(
  db: PoolClient,
  ...messages: OutboxMessage[]
): Promise<void> {
  if (messages.length === 0) {
    return;
  }
  // Um INSERT só para o lote: `unnest` mantém a ordem dos arrays, e o `seq`
  // sai na mesma ordem. O `eventId` repetido (o mesmo lote gravado de novo
  // depois de um COMMIT sem resposta) não entra duas vezes.
  await db.query(
    `INSERT INTO outbox (id, topic, message_key, type, payload, headers)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[],
                          $5::json[], $6::jsonb[])
     ON CONFLICT (id) DO NOTHING`,
    [
      messages.map((m) => m.event.eventId),
      messages.map((m) => m.topic),
      messages.map((m) => m.key),
      messages.map((m) => m.event.type),
      messages.map((m) => JSON.stringify(m.event)),
      messages.map((m) => JSON.stringify(m.headers)),
    ],
  );
}

/** Chave do advisory lock que deixa um relay por vez publicar o outbox. */
const RELAY_LOCK = 7_402_013;

/**
 * Trava as próximas mensagens a publicar, na ordem em que foram gravadas.
 *
 * Um relay por vez (ADR 8): o lote é lido sob um advisory lock da transação, e
 * a instância que não o consegue devolve uma lista vazia e tenta na próxima
 * volta. A chave das mensagens é o show, e num show lotado todas as entradas
 * têm a mesma chave; com um relay só, o lote leva várias mensagens do mesmo
 * show, na ordem, em vez de uma por chave.
 */
export async function lockPending(
  db: PoolClient,
  limit: number,
): Promise<OutboxRow[]> {
  const {
    rows: [{ locked }],
  } = await db.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock($1) AS locked',
    [RELAY_LOCK],
  );
  if (!locked) {
    return [];
  }
  const { rows } = await db.query<OutboxRow>(
    `SELECT id, topic, message_key, type, payload, headers
       FROM outbox
      WHERE published_at IS NULL
      ORDER BY seq
      LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function markPublished(
  db: PoolClient,
  ids: string[],
): Promise<void> {
  await db.query(
    'UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])',
    [ids],
  );
}

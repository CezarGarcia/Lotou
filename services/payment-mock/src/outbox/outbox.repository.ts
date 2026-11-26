import type { PoolClient } from 'pg';
import type { TraceHeaders } from '../kafka/trace-headers.js';
import type { Envelope } from '../messages/events.js';

export interface OutboxMessage {
  topic: string;
  key: string;
  event: Envelope<string, unknown>;
  /** Trace do comando que causou a resposta; o relay o leva ao Kafka. */
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

/** Grava a mensagem no outbox, na transação de quem chama. */
export async function enqueue(
  db: PoolClient,
  message: OutboxMessage,
): Promise<void> {
  await db.query(
    `INSERT INTO outbox (id, topic, message_key, type, payload, headers)
     VALUES ($1, $2, $3, $4, $5::json, $6::jsonb)`,
    [
      message.event.eventId,
      message.topic,
      message.key,
      message.event.type,
      JSON.stringify(message.event),
      JSON.stringify(message.headers),
    ],
  );
}

/**
 * Trava as próximas mensagens a publicar, na ordem em que foram gravadas.
 *
 * Seguro com mais de uma instância: `SKIP LOCKED` faz cada relay pegar linhas
 * diferentes, e o `NOT EXISTS` só entrega uma mensagem se não houver outra
 * anterior da mesma chave ainda pendente, travada ou não. Assim, enquanto um
 * relay publica a primeira resposta de um pedido, nenhum outro publica a
 * segunda antes dela; a ordem por chave, que é a que o Kafka garante dentro da
 * partição, se mantém. O preço é uma mensagem por chave em cada lote, e um
 * pedido tem poucas respostas.
 */
export async function lockPending(
  db: PoolClient,
  limit: number,
): Promise<OutboxRow[]> {
  const { rows } = await db.query<OutboxRow>(
    `SELECT o.id, o.topic, o.message_key, o.type, o.payload, o.headers
       FROM outbox o
      WHERE o.published_at IS NULL
        AND NOT EXISTS (
              SELECT 1 FROM outbox earlier
               WHERE earlier.published_at IS NULL
                 AND earlier.topic = o.topic
                 AND earlier.message_key = o.message_key
                 AND earlier.seq < o.seq)
      ORDER BY o.seq
      LIMIT $1
        FOR UPDATE OF o SKIP LOCKED`,
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

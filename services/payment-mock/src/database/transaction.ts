import type { Pool, PoolClient } from 'pg';

/**
 * Roda `work` numa transação: COMMIT se ela termina, ROLLBACK se lança. A
 * conexão volta ao pool nos dois casos; se o próprio ROLLBACK falhar (conexão
 * caída), ela é descartada em vez de voltar ao pool.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

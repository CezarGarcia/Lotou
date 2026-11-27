import type { Pool, PoolClient } from 'pg';

/**
 * Roda `work` numa transação: COMMIT se ela termina, ROLLBACK se lança. A
 * conexão volta ao pool nos dois casos; se ela caiu (o Postgres reiniciou, por
 * exemplo), é descartada em vez de voltar ao pool.
 *
 * Uma conexão emprestada do pool que cai emite `error`. Sem quem escute, o Node
 * derruba o processo inteiro; aqui o erro só marca a conexão como quebrada, e a
 * consulta em andamento falha normalmente (o chamador repete ou devolve 503).
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  const onError = (error: Error) => {
    broken = error;
  };
  client.on('error', onError);
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
    client.off('error', onError);
    client.release(broken);
  }
}

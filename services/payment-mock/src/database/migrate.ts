import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

/** Pasta dos arquivos `NNNN_nome.sql`, ao lado deste módulo (em src e em dist). */
export const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);

/** Chave do advisory lock que serializa as migrações entre instâncias. */
const MIGRATION_LOCK = 7_402_001;

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

/**
 * Aplica, em ordem, as migrações que o banco ainda não tem, todas numa
 * transação: ou o esquema sobe inteiro, ou nada muda.
 *
 * Duas instâncias subindo juntas não aplicam a mesma migração duas vezes: o
 * advisory lock faz a segunda esperar a primeira e, ao entrar, ela já encontra
 * tudo aplicado. Devolve os nomes das migrações aplicadas agora.
 */
export async function migrate(
  pool: Pool,
  dir: URL = MIGRATIONS_DIR,
): Promise<string[]> {
  const files = (await readdir(dir))
    .filter((file) => MIGRATION_FILE.test(file))
    .sort();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text        PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations',
    );
    const done = new Set(rows.map((row) => row.version));

    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) {
        continue;
      }
      await client.query(await readFile(new URL(file, dir), 'utf8'));
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [file],
      );
      applied.push(file);
    }
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

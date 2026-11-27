import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from './transaction.js';

/** Uma conexão de mentira: guarda as consultas e pode "cair" no meio da transação. */
class FakeClient extends EventEmitter {
  readonly queries: string[] = [];
  released: Error | boolean | undefined =
    'não devolvida' as unknown as undefined;
  dropped = false;

  query(sql: string): Promise<void> {
    this.queries.push(sql);
    return this.dropped
      ? Promise.reject(new Error('Connection terminated unexpectedly'))
      : Promise.resolve();
  }

  release(error?: Error | boolean): void {
    this.released = error;
  }

  /** O que o pg faz quando o Postgres derruba a conexão emprestada. */
  drop(): void {
    this.dropped = true;
    this.emit(
      'error',
      new Error('terminating connection due to administrator command'),
    );
  }
}

const poolOf = (client: FakeClient) =>
  ({
    connect: () => Promise.resolve(client as unknown as PoolClient),
  }) as unknown as Pool;

describe('withTransaction', () => {
  it('faz COMMIT e devolve a conexão ao pool', async () => {
    const client = new FakeClient();
    await expect(
      withTransaction(poolOf(client), () => Promise.resolve(42)),
    ).resolves.toBe(42);
    expect(client.queries).toEqual(['BEGIN', 'COMMIT']);
    expect(client.released).toBeUndefined();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('faz ROLLBACK quando o trabalho falha', async () => {
    const client = new FakeClient();
    await expect(
      withTransaction(poolOf(client), () => Promise.reject(new Error('regra'))),
    ).rejects.toThrow('regra');
    expect(client.queries).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.released).toBeUndefined();
  });

  it('não derruba o processo quando a conexão cai no meio, e a descarta', async () => {
    const client = new FakeClient();
    await expect(
      withTransaction(poolOf(client), async (c) => {
        client.drop();
        await c.query('SELECT 1');
      }),
    ).rejects.toThrow('Connection terminated unexpectedly');
    // O erro emitido teve quem escutasse (sem isso, o EventEmitter lançaria) e a conexão
    // voltou ao pool marcada como quebrada.
    expect(client.released).toBeInstanceOf(Error);
    expect(client.listenerCount('error')).toBe(0);
  });
});

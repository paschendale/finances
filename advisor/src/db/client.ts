import pg from 'pg';

const { Pool, types } = pg;

// NUMERIC comes back as string by default; the ledger's amounts fit in a double for display,
// and every arithmetic decision is re-done in SQL, so parse to number here.
types.setTypeParser(1700, (v: string) => Number.parseFloat(v));
// DATE → keep as 'YYYY-MM-DD' string, never a Date in local time.
types.setTypeParser(1082, (v: string) => v);

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(databaseUrl: string): Db {
  const pool = new Pool({ connectionString: databaseUrl, max: 8, idleTimeoutMillis: 30_000 });
  pool.on('error', () => {
    /* surfaced by the next query */
  });
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T>(q: Queryable, text: string, params: unknown[] = []): Promise<T> {
  const res = await q.query(text, params);
  const row = res.rows[0];
  if (!row) throw new Error(`Expected one row, got none: ${text.slice(0, 80)}`);
  return row as T;
}

export async function maybeOne<T>(q: Queryable, text: string, params: unknown[] = []): Promise<T | null> {
  const res = await q.query(text, params);
  return (res.rows[0] as T | undefined) ?? null;
}

export async function many<T>(q: Queryable, text: string, params: unknown[] = []): Promise<T[]> {
  const res = await q.query(text, params);
  return res.rows as T[];
}

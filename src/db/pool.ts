import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://wst:wst@localhost:5432/wst',
  max: Number(process.env.PG_POOL_MAX || 20),
});

export const query = (text: string, params?: unknown[]) => pool.query(text, params);

const RETRYABLE = new Set(['40P01', '40001']); // deadlock detected, serialization failure

/**
 * Runs fn inside a transaction. Deadlocks and serialization failures are retried a few times:
 * under concurrent stock issues PostgreSQL may pick a victim, and the correct behaviour is to
 * replay the whole transaction rather than surface a 500 to the caller.
 */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>, attempts = 3): Promise<T> {
  let lastError: any;
  for (let i = 0; i < attempts; i++) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e: any) {
      await c.query('ROLLBACK').catch(() => undefined);
      lastError = e;
      if (!RETRYABLE.has(e?.code)) throw e;
      await new Promise((res) => setTimeout(res, 25 * (i + 1) + Math.random() * 25));
    } finally {
      c.release();
    }
  }
  throw lastError;
}

import pg from 'pg';
import { config } from '../config.js';

// Return BIGINT (int8) as JS numbers. Amounts are cents well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// SUM() over BIGINT yields NUMERIC; money is integer cents, so return numbers there too.
pg.types.setTypeParser(1700, (v) => Number(v));
// Keep DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, (v) => v);

const useSsl = config.isProd && !/localhost|127\.0\.0\.1/.test(config.databaseUrl) && !config.databaseUrl.includes('.internal');

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

export type Db = pg.Pool | pg.PoolClient;

/** Run fn inside a transaction. Rolls back on any error. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

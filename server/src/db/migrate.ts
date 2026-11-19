import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(log = true): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    // Serialise concurrent deploys.
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        if (log) console.log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (log && applied.length === 0) console.log('database is up to date');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

// Run directly: `npm run migrate`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

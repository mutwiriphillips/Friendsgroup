export default async function setup() {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://savings:savings@localhost:5432/savings_test';
  process.env.NODE_ENV = 'test';
  const { pool } = await import('../src/db/pool.js');
  const { migrate } = await import('../src/db/migrate.js');
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await pool.end();
}

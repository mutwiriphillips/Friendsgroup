import bcrypt from 'bcryptjs';
import { pool } from './pool.js';
import { migrate } from './migrate.js';

/** Creates the first Super Administrator from SEED_ADMIN_* env vars, only if no users exist. */
async function seed() {
  await migrate(false);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) {
    console.log('Users already exist; nothing to seed.');
    return;
  }
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password || password.length < 10) {
    throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (min 10 chars) to create the first administrator.');
  }
  await pool.query(
    `INSERT INTO users (email, password_hash, role, must_change_password) VALUES ($1, $2, 'super_admin', true)`,
    [email.toLowerCase(), await bcrypt.hash(password, 12)],
  );
  console.log(`Super administrator created: ${email} (password change required at first login)`);
}

seed()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

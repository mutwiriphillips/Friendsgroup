import { pool } from './pool.js';
import { config } from '../config.js';
import { blindIndex, decryptField, encryptField, hasFieldKey } from '../lib/crypto.js';

/**
 * Encrypts National IDs that were saved before FIELD_ENCRYPTION_KEY was set (stored as "plain:..."),
 * and recomputes their lookup hash with the key. Run once after setting the key:  npm run rekey
 */
async function main() {
  if (!hasFieldKey()) throw new Error('Set FIELD_ENCRYPTION_KEY first.');
  if (config.fieldKey.length !== 64) throw new Error('FIELD_ENCRYPTION_KEY must be 64 hex characters.');
  const { rows } = await pool.query(`SELECT id, national_id_enc FROM members WHERE national_id_enc LIKE 'plain:%'`);
  for (const r of rows) {
    const id = decryptField(r.national_id_enc);
    await pool.query(`UPDATE members SET national_id_enc = $2, national_id_hash = $3 WHERE id = $1`, [r.id, encryptField(id), blindIndex(id)]);
  }
  console.log(`Encrypted ${rows.length} National ID(s).`);
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });

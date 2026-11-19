import { pool, withTx } from './pool.js';
import { eraseRecords } from '../services/reset.js';

/** Fresh start for record keeping: members stay, everything recorded for them is cleared. Irreversible, so it needs:
 *    CONFIRM_ERASE_RECORDS=yes npm run reset-records            */
async function main() {
  if (process.env.CONFIRM_ERASE_RECORDS !== 'yes') {
    console.error('This erases ALL contributions, invoices, fines, payments and other records (members are kept). Set CONFIRM_ERASE_RECORDS=yes to proceed.');
    process.exit(1);
  }
  const done = await withTx((c) => eraseRecords(c));
  console.log('Records erased:', JSON.stringify(done));
  await pool.end();
}
main().catch((e) => { console.error(e.message); process.exit(1); });

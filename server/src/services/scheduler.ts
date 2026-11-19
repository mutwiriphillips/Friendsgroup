import { pool, withTx } from '../db/pool.js';
import { runReminders, sendOutbox } from './notifications.js';
import { accrueLateFines, generateObligationsForMonth, isAdminManaged, todayEAT } from './obligations.js';

/**
 * Daily housekeeping, safe to run repeatedly (every step is idempotent):
 *  - make sure this month's and next month's obligations exist
 *  - advance statuses and accrue late fines
 * A Postgres advisory lock keeps multiple instances from running it at once.
 */
export async function runDailyJob(): Promise<void> {
  await withTx(async (c) => {
    const { rows } = await c.query('SELECT pg_try_advisory_xact_lock(727275) AS ok');
    if (!rows[0].ok) return;
    if (await isAdminManaged(c)) return; // the administrator decides what is owed: nothing is generated, marked overdue, fined or reminded automatically
    const today = await todayEAT(c);
    const thisMonth = `${today.slice(0, 7)}-01`;
    await generateObligationsForMonth(c, thisMonth, today);
    await accrueLateFines(c, today);
    await runReminders(c, today);
  });
  await sendOutbox();
}

export function startScheduler(): void {
  const tick = () => runDailyJob().catch((err) => console.error('daily job failed', err));
  setTimeout(tick, 15_000);
  setInterval(tick, 6 * 60 * 60 * 1000); // idempotent, so running every 6h is harmless
  void pool; // keep import for clarity
}

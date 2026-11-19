import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTx } from '../src/db/pool.js';
import { accrueLateFines } from '../src/services/obligations.js';
import { confirmRegister, createMeeting, setAttendance } from '../src/services/governance.js';
import { KES, SYSTEM, finesOutstanding, monthsFor, newMember, resetDb } from './helpers.js';

beforeEach(resetDb);
afterAll(async () => { await pool.end(); });
const setPolicy = (v: object) => pool.query(`INSERT INTO system_settings (key, value) VALUES ('auto_fines', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(v)]);

describe('suspending automatic fines', () => {
  it('adds no late fine while suspended, keeps contributions overdue, and never fines the suspended period when switched back on', async () => {
    const m = await newMember();
    await monthsFor(['2026-01-01', '2026-02-01'], '2026-01-05');
    await setPolicy({ enabled: false, from: null });
    await withTx((c) => accrueLateFines(c, '2026-03-01'));
    expect(await finesOutstanding(m.id)).toBe(0);
    expect((await pool.query(`SELECT status FROM monthly_obligations WHERE member_id = $1`, [m.id])).rows.map((r) => r.status)).toEqual(['overdue', 'overdue']);
    // switched back on from 1 April: earlier months are still never fined
    await setPolicy({ enabled: true, from: '2026-04-01' });
    await withTx((c) => accrueLateFines(c, '2026-03-20'));
    expect(await finesOutstanding(m.id)).toBe(0);
    await monthsFor(['2026-04-01'], '2026-04-02');
    await withTx((c) => accrueLateFines(c, '2026-04-20'));
    expect(await finesOutstanding(m.id)).toBe(KES(200)); // only April
  });

  it('adds no absence fine while suspended', async () => {
    const m = await newMember();
    const run = async (day: string) => {
      const id = await withTx((c) => createMeeting(c, { title: `Meeting ${day}`, scheduledAt: `${day}T09:00:00+03:00`, venue: 'Hall' }, SYSTEM));
      await withTx((c) => setAttendance(c, id, [{ memberId: m.id, status: 'absent' }], SYSTEM));
      await withTx((c) => confirmRegister(c, id, SYSTEM));
    };
    await setPolicy({ enabled: false, from: null });
    await run('2026-02-10');
    expect(await finesOutstanding(m.id)).toBe(0);
    await setPolicy({ enabled: true, from: '2026-03-01' });
    await run('2026-03-10');
    expect(await finesOutstanding(m.id)).toBe(KES(5000));
  });
});

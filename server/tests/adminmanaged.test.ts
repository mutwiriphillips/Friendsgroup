import { describe, it, expect, beforeEach } from 'vitest';
import { pool } from '../src/db/pool.js';
import { dueDateFor, accrueLateFines } from '../src/services/obligations.js';
import { resetDb } from './helpers.js';

describe('administrator-managed mode', () => {
  beforeEach(resetDb);
  it('a month falls due on the deadline day of the following month', () => {
    expect(dueDateFor('2026-10-01', 10)).toBe('2026-11-10');
    expect(dueDateFor('2026-12-01', 10)).toBe('2027-01-10');
    expect(dueDateFor('2026-10-01', 10, 0)).toBe('2026-10-10');
  });
  it('creates no automatic fines while managed', async () => {
    await pool.query(`INSERT INTO system_settings (key, value) VALUES ('admin_managed', '{"enabled": true}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    expect((await accrueLateFines(pool, '2026-12-31')).fines).toBe(0);
  });
});

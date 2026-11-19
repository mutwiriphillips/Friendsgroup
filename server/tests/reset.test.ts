import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool, withTx } from '../src/db/pool.js';
import { eraseRecords } from '../src/services/reset.js';
import { createStaff, resetDb } from './helpers.js';

afterAll(async () => { await pool.end(); });
beforeEach(resetDb);

describe('erase records', () => {
  it('clears records, keeps members, logins, staff, rules and other records', async () => {
    const staff = await createStaff('super_admin', 'root@x.org');
    const m = (await pool.query(`INSERT INTO members (membership_no, full_name, national_id_enc, national_id_hash, phone, mpesa_phone, registered_on) VALUES ('MBR-0001','Gone Gina','x','h','254700000001','254700000001','2025-01-01') RETURNING id`)).rows[0].id as string;
    await pool.query(`INSERT INTO savings_transactions (member_id, type, amount_cents, reason, is_historical, period) VALUES ($1,'historical',150000,'t',true,'2026-01-01')`, [m]);
    await pool.query(`INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, status, is_historical, period) VALUES ('FN-X',$1,'late_payment',20000,'2026-01-11','t','outstanding',true,'2026-01-01')`, [m]);
    await pool.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note) SELECT id, member_id, 'charge', 20000, 't' FROM fines`);
    await pool.query(`INSERT INTO users (email, password_hash, role, member_id) VALUES ('gina@x.org','x','member',$1)`, [m]);
    const f = (await pool.query(`INSERT INTO stored_files (name, mime_type, size_bytes, data, uploaded_by) VALUES ('keep.pdf','application/pdf',3,'abc',$1) RETURNING id`, [staff.id])).rows[0].id;
    await pool.query(`INSERT INTO documents (title, category, file_id, visibility, uploaded_by) VALUES ('Constitution','constitution',$1,'officials',$2)`, [f, staff.id]);
    const done = await withTx((c) => eraseRecords(c));
    expect(done).toMatchObject({ membersKept: 1, savingsEntries: 1, fines: 1 });
    for (const t of ['savings_transactions', 'fines', 'fine_ledger', 'payments', 'monthly_obligations']) {
      expect(Number((await pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n)).toBe(0);
    }
    expect(Number((await pool.query(`SELECT count(*) AS n FROM members`)).rows[0].n)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM users WHERE role = 'member'`)).rows[0].n)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM users WHERE email = 'root@x.org'`)).rows[0].n)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM documents WHERE title = 'Constitution'`)).rows[0].n)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM audit_logs WHERE action = 'data.records_erased'`)).rows[0].n)).toBe(1);
    // the guards are back on
    await expect(pool.query(`DELETE FROM documents`)).rejects.toThrow();
  });
});

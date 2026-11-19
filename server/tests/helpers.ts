import bcrypt from 'bcryptjs';
import { pool, withTx } from '../src/db/pool.js';
import { registerMember, registerMemberSchema } from '../src/services/members.js';
import { confirmPayment } from '../src/services/ledger.js';
import { generateObligationsForMonth, accrueLateFines } from '../src/services/obligations.js';
import type { Actor } from '../src/lib/audit.js';

export const SYSTEM: Actor = { userId: null, role: 'system' };
export const KES = (n: number) => n * 100;

export async function resetDb() {
  await pool.query(`
    TRUNCATE members, users, login_activity, payments, financial_years, notifications, audit_logs,
             member_status_history, monthly_obligations, savings_transactions, savings_allocations,
             fines, fine_ledger, meetings, attendance, withdrawals, withdrawal_approvals, income, expenditure,
             payment_submissions, submission_events, statement_batches, statement_lines, reconciliation_periods,
             discrepancies, announcements, documents, stored_files, message_outbox RESTART IDENTITY CASCADE`);
  await pool.query(`DELETE FROM system_settings WHERE key IN ('auto_fines', 'admin_managed')`); // tests start with automatic fines on (the production default after migration is suspended)
  // CASCADE also clears rule_versions (obligations reference it), so restore the default group rules.
  await pool.query(`TRUNCATE rule_versions RESTART IDENTITY CASCADE`);
  await pool.query(
    `INSERT INTO rule_versions (effective_from, monthly_amount_cents, deadline_day, late_fine_cents, absence_fine_cents, meetings_per_year, reason, due_month_offset)
     VALUES ('2000-01-01', 150000, 10, 20000, 500000, 3, 'Initial group rules', 0)`,
  );
}

let nid = 10000000;
export async function newMember(name = 'Test Member', registeredOn = '2026-01-01') {
  nid += 1;
  const phone = `07${String(10000000 + nid).slice(-8)}`;
  const r = await withTx((c) => registerMember(c, registerMemberSchema.parse({ fullName: name, nationalId: String(nid), phone, registeredOn }), SYSTEM));
  // Test members are fully compliant unless a test says otherwise (the next of kin form is covered in its own tests).
  await pool.query(`UPDATE members SET nok_submitted_at = now() WHERE id = $1`, [r.id ?? (r as any).memberId]);
  return { ...r, phone };
}

export async function monthsFor(months: string[], asOf: string) {
  for (const m of months) await withTx((c) => generateObligationsForMonth(c, m, asOf));
  await withTx((c) => accrueLateFines(c, asOf));
}

let rc = 0;
/** Record + confirm a payment the way the treasurer / Daraja callback flow does. */
export async function pay(
  memberId: string,
  purpose: 'savings' | 'fine',
  amountCents: number,
  opts: { occurredAt?: string; fineIds?: string[]; receipt?: string } = {},
) {
  rc += 1;
  const receipt = opts.receipt ?? `TST${String(rc).padStart(7, '0')}`;
  const ins = await pool.query(
    `INSERT INTO payments (member_id, purpose, channel, amount_cents, status, mpesa_receipt, fine_ids, occurred_at)
     VALUES ($1,$2,'stk_push',$3,'initiated',$4,$5,$6) RETURNING id`,
    [memberId, purpose, amountCents, receipt, opts.fineIds ?? null, opts.occurredAt ?? null],
  );
  const id: string = ins.rows[0].id;
  const outcome = await withTx((c) => confirmPayment(c, id, SYSTEM));
  return { id, outcome };
}

export async function obligations(memberId: string) {
  return (await pool.query(`SELECT period, status, paid_cents FROM monthly_obligations WHERE member_id = $1 ORDER BY period`, [memberId])).rows;
}
export async function savingsBalance(memberId: string): Promise<number> {
  return Number((await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE member_id=$1`, [memberId])).rows[0].b);
}
export async function finesOutstanding(memberId: string): Promise<number> {
  return Number((await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM fine_ledger WHERE member_id=$1`, [memberId])).rows[0].b);
}

export async function createStaff(role: 'super_admin' | 'chairperson' | 'treasurer' | 'secretary', email: string, password = 'Password-12345') {
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id`,
    [email, await bcrypt.hash(password, 4), role],
  );
  return { id: rows[0].id as string, email, password };
}

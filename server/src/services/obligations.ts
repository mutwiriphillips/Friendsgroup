import type pg from 'pg';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit.js';
import type { Db } from '../db/pool.js';

export interface RuleVersion {
  id: number;
  effective_from: string;
  monthly_amount_cents: number;
  deadline_day: number;
  late_fine_cents: number;
  absence_fine_cents: number;
  meetings_per_year: number;
  due_month_offset: number;
}

/** Today's date in the group's timezone (Nairobi), as YYYY-MM-DD. */
export async function todayEAT(db: Db): Promise<string> {
  const { rows } = await db.query(`SELECT (now() AT TIME ZONE 'Africa/Nairobi')::date AS d`);
  return rows[0].d;
}

export async function ruleAt(db: Db, date: string): Promise<RuleVersion> {
  const { rows } = await db.query(
    `SELECT * FROM rule_versions WHERE effective_from <= $1::date ORDER BY effective_from DESC LIMIT 1`,
    [date],
  );
  if (!rows[0]) throw new Error('No financial rules configured');
  return rows[0];
}

/** Returns the id of the financial year covering `date`, creating a calendar-year one if needed. */
export async function ensureFinancialYear(db: Db, date: string): Promise<number> {
  const found = await db.query(`SELECT id FROM financial_years WHERE $1::date BETWEEN start_date AND end_date`, [date]);
  if (found.rows[0]) return found.rows[0].id;
  const year = Number(date.slice(0, 4));
  const { rows } = await db.query(
    `INSERT INTO financial_years (label, start_date, end_date, is_current)
     VALUES ($1, $2::date, $3::date, NOT EXISTS (SELECT 1 FROM financial_years WHERE is_current))
     ON CONFLICT (label) DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [String(year), `${year}-01-01`, `${year}-12-31`],
  );
  return rows[0].id;
}

function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/**
 * Generate the obligation for `period` (first of month) for every active member who had registered
 * by the end of that month. Idempotent: UNIQUE(member_id, period) prevents duplicates.
 * The rule in force for the period is snapshotted onto each obligation.
 */
export async function generateObligationsForMonth(
  db: Db,
  periodInput: string,
  asOf: string,
  actor: Actor = SYSTEM_ACTOR,
): Promise<number> {
  const period = firstOfMonth(periodInput);
  const rule = await ruleAt(db, period);
  const fyId = await ensureFinancialYear(db, period);
  const { rowCount } = await db.query(
    `INSERT INTO monthly_obligations
       (member_id, financial_year_id, period, amount_due_cents, due_date, late_fine_cents, status, rule_version_id)
     SELECT m.id, $1, $2::date, $3, ($2::date + $8 * interval '1 month' + ($4 - 1) * interval '1 day')::date, $5,
            CASE WHEN $6::date < $2::date THEN 'not_due'
                 WHEN $6::date <= ($2::date + $8 * interval '1 month' + ($4 - 1) * interval '1 day')::date THEN 'unpaid'
                 ELSE 'overdue' END::obligation_status,
            $7
       FROM members m
      WHERE m.status = 'active'
        AND m.registered_on <= (($2::date + interval '1 month') - interval '1 day')::date
     ON CONFLICT (member_id, period) DO NOTHING`,
    [fyId, period, rule.monthly_amount_cents, rule.deadline_day, rule.late_fine_cents, asOf, rule.id, rule.due_month_offset],
  );
  const created = rowCount ?? 0;
  if (created > 0) {
    await audit(db, actor, 'obligations.generated', 'period', period, { after: { created, ruleVersion: rule.id } });
  }
  return created;
}

/**
 * Advance obligation statuses and accrue late fines. Safe to run any number of times a day:
 *  - not_due -> unpaid once the month has started
 *  - unpaid  -> overdue once the due date has passed
 *  - exactly one KSh late fine per overdue (or late-paid) obligation, guarded by a unique index.
 */
/** True while the administrator decides what is owed (no automatic contributions, overdue marking, fines or allocation). Absent means off. */
export async function isAdminManaged(db: Db): Promise<boolean> {
  return Boolean((await db.query(`SELECT value FROM system_settings WHERE key = 'admin_managed'`)).rows[0]?.value?.enabled);
}

/** A month's contribution falls due on the deadline day of the FOLLOWING month (October's is due on 10 November). Offset 0 = the same month. */
export function dueDateFor(period: string, deadlineDay: number, monthOffset = 1): string {
  const total = Number(period.slice(0, 4)) * 12 + (Number(period.slice(5, 7)) - 1) + monthOffset;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-${String(deadlineDay).padStart(2, '0')}`;
}

export interface AutoFinePolicy { enabled: boolean; from: string | null }
/** The automatic-fines switch. Absent means on (the original behaviour); a "from" date limits it to contributions due and meetings held on or after that date. */
export async function autoFinePolicy(db: Db): Promise<AutoFinePolicy> {
  if (await isAdminManaged(db)) return { enabled: false, from: null };
  const v = (await db.query(`SELECT value FROM system_settings WHERE key = 'auto_fines'`)).rows[0]?.value as Partial<AutoFinePolicy> | undefined;
  return { enabled: v?.enabled ?? true, from: v?.from ?? null };
}
export const autoFinesApply = (p: AutoFinePolicy, date: string) => p.enabled && (!p.from || date >= p.from);

export async function accrueLateFines(db: Db, asOf: string, actor: Actor = SYSTEM_ACTOR): Promise<{ fines: number }> {
  if (await isAdminManaged(db)) return { fines: 0 };
  await db.query(`UPDATE monthly_obligations SET status = 'unpaid' WHERE status = 'not_due' AND period <= $1::date`, [asOf]);
  await db.query(`UPDATE monthly_obligations SET status = 'overdue' WHERE status = 'unpaid' AND due_date < $1::date`, [asOf]);
  const policy = await autoFinePolicy(db);
  if (!policy.enabled) return { fines: 0 };

  const { rowCount } = await db.query(
    `WITH new_fines AS (
       INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, obligation_id)
       SELECT 'FN-' || lpad(nextval('fine_ref_seq')::text, 6, '0'),
              o.member_id, 'late_payment', o.late_fine_cents, $1::date,
              'Late contribution for ' || to_char(o.period, 'FMMonth YYYY'), o.id
         FROM monthly_obligations o
        WHERE o.due_date < $1::date
          AND o.late_fine_cents > 0
          AND o.status IN ('overdue', 'late_paid')
          AND NOT o.is_historical
          AND ($2::date IS NULL OR o.due_date >= $2::date)
       ON CONFLICT (obligation_id) WHERE category = 'late_payment' DO NOTHING
       RETURNING id, member_id, amount_cents
     )
     INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note)
     SELECT id, member_id, 'charge', amount_cents, 'Late payment fine accrued' FROM new_fines`,
    [asOf, policy.from],
  );
  const fines = rowCount ?? 0;
  if (fines > 0) await audit(db, actor, 'fines.late_accrued', 'date', asOf, { after: { fines } });
  return { fines };
}

/** Ensure the one-off late fine exists for a specific obligation (used when a late payment lands). */
export async function ensureLateFine(client: pg.PoolClient, obligationId: string, asOf: string): Promise<void> {
  const { rows } = await client.query(`SELECT * FROM monthly_obligations WHERE id = $1`, [obligationId]);
  const o = rows[0];
  if (!o || o.late_fine_cents <= 0 || o.is_historical || o.due_date >= asOf) return;
  if (!autoFinesApply(await autoFinePolicy(client), String(o.due_date).slice(0, 10))) return;
  const ins = await client.query(
    `INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, obligation_id)
     VALUES ('FN-' || lpad(nextval('fine_ref_seq')::text, 6, '0'), $1, 'late_payment', $2, $3::date, $4, $5)
     ON CONFLICT (obligation_id) WHERE category = 'late_payment' DO NOTHING
     RETURNING id`,
    [o.member_id, o.late_fine_cents, asOf, `Late contribution for ${o.period.slice(0, 7)}`, o.id],
  );
  if (ins.rows[0]) {
    await client.query(
      `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note) VALUES ($1,$2,'charge',$3,'Late payment fine accrued')`,
      [ins.rows[0].id, o.member_id, o.late_fine_cents],
    );
  }
}

import type { Db } from '../db/pool.js';
import { getMemberSummary } from './ledger.js';
import { owedSummary } from './invoices.js';

const EAT = `AT TIME ZONE 'Africa/Nairobi'`;

/** Everything an official needs to see about one member: totals, month-by-month contributions, penalties and manually entered payments. */
export async function memberOverview(db: Db, memberId: string) {
  const summary = await getMemberSummary(db as never, memberId);
  const totals = (await db.query(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type <> 'withdrawal'),0)::bigint AS contributions,
            COALESCE(-SUM(amount_cents) FILTER (WHERE type = 'withdrawal'),0)::bigint AS withdrawn,
            COALESCE(SUM(amount_cents),0)::bigint AS balance,
            0::int AS months_paid
       FROM savings_transactions WHERE member_id = $1`, [memberId])).rows[0];
  // Month by month: sheet entries carry their own month; payments are split across the invoices (months) they cleared.
  const months = (await db.query(
    `SELECT period::text AS period, SUM(amount_cents)::bigint AS amount_cents, string_agg(DISTINCT NULLIF(reference,''), ', ') AS reference, bool_and(imported) AS imported
       FROM (
         SELECT period, amount_cents, reference, is_historical AS imported FROM savings_transactions
          WHERE member_id = $1 AND type <> 'withdrawal' AND period IS NOT NULL
         UNION ALL
         SELECT o.period, a.amount_cents, t.reference, t.is_historical FROM savings_allocations a
           JOIN savings_transactions t ON t.id = a.savings_txn_id JOIN monthly_obligations o ON o.id = a.obligation_id
          WHERE t.member_id = $1 AND a.reversed_at IS NULL AND t.period IS NULL
         UNION ALL
         SELECT date_trunc('month', occurred_at ${EAT})::date, amount_cents, reference, is_historical FROM savings_transactions t
          WHERE member_id = $1 AND type <> 'withdrawal' AND period IS NULL AND NOT EXISTS (SELECT 1 FROM savings_allocations a WHERE a.savings_txn_id = t.id)
       ) x GROUP BY period ORDER BY period`, [memberId])).rows;
  const penalties = (await db.query(
    `SELECT f.id, f.reference, f.category::text AS category, f.reason, f.amount_cents, f.imposed_on::text AS imposed_on, f.period::text AS period, f.status::text AS status
       FROM fines f WHERE f.member_id = $1 AND f.status <> 'reversed' ORDER BY f.imposed_on, f.created_at`, [memberId])).rows;
  const owed = await owedSummary(db, memberId);
  const manual = (await db.query(
    `SELECT mp.id, mp.period::text AS period, mp.paid_on::text AS paid_on, mp.kind, mp.allocation, mp.amount_cents, mp.mpesa_code, mp.transaction_message, mp.created_at, mp.reversed_at, mp.reversed_reason
       FROM manual_payments mp WHERE mp.member_id = $1 ORDER BY mp.created_at DESC`, [memberId])).rows;
  // Every invoice posted for this member, paid or not: contributions and fines, oldest first.
  const invoices = (await db.query(
    `SELECT * FROM (
       SELECT o.id, 'contribution' AS kind, 'Contribution' AS label, o.period::text AS month, o.due_date::text AS due_date, o.amount_due_cents AS amount_cents,
              CASE WHEN o.status IN ('paid','late_paid') THEN 'paid' ELSE 'unpaid' END AS status, o.created_at AS posted_at,
              (SELECT MAX(t.occurred_at) FROM savings_allocations a JOIN savings_transactions t ON t.id = a.savings_txn_id WHERE a.obligation_id = o.id AND a.reversed_at IS NULL) AS paid_at
         FROM monthly_obligations o WHERE o.member_id = $1
       UNION ALL
       SELECT f.id, CASE f.category::text WHEN 'late_payment' THEN 'late_fine' WHEN 'absence' THEN 'meeting_fine' ELSE 'other_fine' END,
              CASE f.category::text WHEN 'late_payment' THEN 'Late fine' WHEN 'absence' THEN 'Missing-meeting fine' ELSE 'Other fine' END,
              COALESCE(f.period, date_trunc('month', f.imposed_on))::date::text, f.imposed_on::text, f.amount_cents,
              CASE f.status::text WHEN 'outstanding' THEN 'unpaid' WHEN 'paid' THEN 'paid' ELSE f.status::text END, f.created_at,
              (SELECT MAX(l.created_at) FROM fine_ledger l WHERE l.fine_id = f.id AND l.entry_type = 'payment')
         FROM fines f WHERE f.member_id = $1 AND f.status <> 'reversed'
     ) x ORDER BY month, posted_at`, [memberId])).rows;
  const attendance = (await db.query(
    `SELECT COUNT(*) FILTER (WHERE a.status = 'present')::int AS present, COUNT(*) FILTER (WHERE a.status = 'absent')::int AS absent, COUNT(*) FILTER (WHERE a.status = 'excused')::int AS excused
       FROM attendance a WHERE a.member_id = $1`, [memberId])).rows[0];
  return {
    owed,
    totals: {
      contributionsCents: Number(totals.contributions), monthsPaid: months.filter((m) => Number(m.amount_cents) > 0).length, withdrawnCents: Number(totals.withdrawn), balanceCents: Number(totals.balance),
      penaltiesAccruedCents: Number(summary.fines.accruedCents ?? 0), penaltiesPaidCents: Number(summary.fines.paidCents ?? 0),
      penaltiesWaivedCents: Number(summary.fines.waivedCents ?? 0), penaltiesOutstandingCents: Number(summary.fines.outstandingCents ?? 0),
    },
    months: months.map((m) => ({ ...m, amount_cents: Number(m.amount_cents) })),
    penalties: penalties.map((p) => ({ ...p, amount_cents: Number(p.amount_cents) })),
    manual: manual.map((m) => ({ ...m, amount_cents: Number(m.amount_cents) })),
    invoices: invoices.map((i) => ({ ...i, amount_cents: Number(i.amount_cents) })),
    attendance,
  };
}

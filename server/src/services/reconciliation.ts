import type pg from 'pg';
import { audit, type Actor } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { confirmPayment } from './ledger.js';
import { ruleAt } from './obligations.js';
import type { Db } from '../db/pool.js';

type Client = pg.PoolClient;

const EAT = `AT TIME ZONE 'Africa/Nairobi'`;
const num = (v: unknown) => Number(v ?? 0);

function monthBounds(period: string) {
  const start = `${period.slice(0, 7)}-01`;
  return start;
}

// ================================================================ cash position

/** Cash movements by category in [from, to). Pending, failed, reversed-away and unmatched money never appears. */
async function cashMovements(db: Db, from: string | null, to: string) {
  const dateFilter = (col: string) => `${from ? `(${col} ${EAT})::date >= $1::date AND ` : ''}(${col} ${EAT})::date < $${from ? 2 : 1}::date`;
  const params = from ? [from, to] : [to];
  const sav = await db.query(
    `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type IN ('contribution','reversal')),0) AS receipts,
            COALESCE(-SUM(amount_cents) FILTER (WHERE type = 'withdrawal'),0) AS withdrawals
       FROM savings_transactions WHERE NOT is_historical AND ${dateFilter('created_at')}`,
    params,
  );
  const fines = await db.query(
    `SELECT COALESCE(-SUM(amount_cents) FILTER (WHERE entry_type IN ('payment','payment_reversal')),0) AS collected
       FROM fine_ledger WHERE ${dateFilter('created_at')}`,
    params,
  );
  const inc = await db.query(
    `SELECT COALESCE(SUM(amount_cents),0) AS other FROM income WHERE ${from ? 'received_on >= $1::date AND received_on < $2::date' : 'received_on < $1::date'}`,
    params,
  );
  const exp = await db.query(
    `SELECT COALESCE(SUM(amount_cents),0) AS spent FROM expenditure WHERE status = 'paid' AND ${from ? 'spent_on >= $1::date AND spent_on < $2::date' : 'spent_on < $1::date'}`,
    params,
  );
  return {
    savingsReceiptsCents: num(sav.rows[0].receipts),
    fineCollectionsCents: num(fines.rows[0].collected),
    otherIncomeCents: num(inc.rows[0].other),
    expenditureCents: num(exp.rows[0].spent),
    withdrawalsCents: num(sav.rows[0].withdrawals),
  };
}

export async function cashBalanceBefore(db: Db, date: string): Promise<number> {
  const m = await cashMovements(db, null, date);
  return m.savingsReceiptsCents + m.fineCollectionsCents + m.otherIncomeCents - m.expenditureCents - m.withdrawalsCents;
}

// ================================================================ monthly summary

export async function computeSummary(db: Db, periodInput: string) {
  const period = monthBounds(periodInput);
  const next = (await db.query(`SELECT ($1::date + interval '1 month')::date AS d`, [period])).rows[0].d as string;
  const monthDate = (col: string) => `(${col} ${EAT})::date >= $1::date AND (${col} ${EAT})::date < $2::date`;
  const rule = await ruleAt(db, period);

  const [ob, members, recv, alloc, held, subs, failed, reversedPay, fineAcc, fineFlows, fineOut, evidence] = await Promise.all([
    db.query(
      `SELECT count(*) AS n, COALESCE(SUM(amount_due_cents),0) AS expected,
              count(*) FILTER (WHERE status = 'paid') AS on_time_n,       COALESCE(SUM(amount_due_cents) FILTER (WHERE status = 'paid'),0) AS on_time,
              count(*) FILTER (WHERE status = 'late_paid') AS late_n,      COALESCE(SUM(amount_due_cents) FILTER (WHERE status = 'late_paid'),0) AS late,
              count(*) FILTER (WHERE status IN ('unpaid','overdue','not_due')) AS open_n,
              COALESCE(SUM(amount_due_cents) FILTER (WHERE status IN ('unpaid','overdue','not_due')),0) AS open_amt
         FROM monthly_obligations WHERE period = $1::date AND NOT is_historical`,
      [period],
    ),
    db.query(`SELECT count(*) AS n FROM members WHERE status = 'active'`),
    db.query(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE type = 'contribution'),0) AS contributions,
              COALESCE(SUM(amount_cents) FILTER (WHERE type = 'reversal'),0) AS reversals
         FROM savings_transactions WHERE NOT is_historical AND ${monthDate('created_at')}`,
      [period, next],
    ),
    db.query(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE ${monthDate('allocated_at')}),0)
            - COALESCE(SUM(amount_cents) FILTER (WHERE reversed_at IS NOT NULL AND ${monthDate('reversed_at')}),0) AS allocated
         FROM savings_allocations`,
      [period, next],
    ),
    db.query(`SELECT count(*) AS n, COALESCE(SUM(amount_cents),0) AS amt FROM payments WHERE status IN ('held','unmatched')`),
    db.query(`SELECT count(*) AS n, COALESCE(SUM(amount_cents),0) AS amt FROM payment_submissions WHERE status IN ('pending','clarification')`),
    db.query(`SELECT count(*) AS n, COALESCE(SUM(amount_cents),0) AS amt FROM payments WHERE status IN ('failed','cancelled') AND ${monthDate('created_at')}`, [period, next]),
    db.query(
      `SELECT count(*) AS n, COALESCE(SUM((after->>'amountCents')::bigint),0) AS amt FROM audit_logs WHERE action = 'payment.reversed' AND ${monthDate('at')}`,
      [period, next],
    ),
    db.query(
      `SELECT f.category, COALESCE(SUM(fl.amount_cents),0) AS amt
         FROM fine_ledger fl JOIN fines f ON f.id = fl.fine_id
        WHERE fl.entry_type = 'charge' AND ${monthDate('fl.created_at')} GROUP BY f.category`,
      [period, next],
    ),
    db.query(
      `SELECT COALESCE(-SUM(amount_cents) FILTER (WHERE entry_type IN ('payment','payment_reversal')),0) AS paid,
              COALESCE(-SUM(amount_cents) FILTER (WHERE entry_type IN ('waiver','reversal')),0) AS waived
         FROM fine_ledger WHERE ${monthDate('created_at')}`,
      [period, next],
    ),
    db.query(
      `SELECT COALESCE(SUM(amount_cents),0) AS outstanding,
              COALESCE(SUM(amount_cents) FILTER (WHERE entry_type = 'charge'),0) AS accrued_total,
              COALESCE(-SUM(amount_cents) FILTER (WHERE entry_type IN ('payment','payment_reversal')),0) AS paid_total,
              COALESCE(-SUM(amount_cents) FILTER (WHERE entry_type IN ('waiver','reversal')),0) AS waived_total
         FROM fine_ledger WHERE (created_at ${EAT})::date < $1::date`,
      [next],
    ),
    db.query(
      `SELECT count(*) AS n,
              count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM statement_lines s WHERE s.receipt = p.mpesa_receipt)) AS missing,
              (SELECT count(*) FROM statement_lines s WHERE ${monthDate('s.txn_time')}) AS lines
         FROM payments p WHERE p.status = 'confirmed' AND NOT p.is_historical AND p.mpesa_receipt IS NOT NULL AND ${monthDate('p.confirmed_at')}`,
      [period, next],
    ),
  ]);

  const byCat = Object.fromEntries(fineAcc.rows.map((r) => [r.category, num(r.amt)]));
  const opening = await cashBalanceBefore(db, period);
  const move = await cashMovements(db, period, next);
  const income = move.savingsReceiptsCents + move.fineCollectionsCents + move.otherIncomeCents;
  const expenditure = move.expenditureCents + move.withdrawalsCents;
  const o = ob.rows[0];
  const e = evidence.rows[0];
  const evidenceLevel: 'full' | 'partial' | 'incomplete' = num(e.n) === 0 ? 'full' : num(e.lines) === 0 ? 'incomplete' : num(e.missing) > 0 ? 'partial' : 'full';

  const savingsBalance = num((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions`)).rows[0].b);
  return {
    period,
    groupName: process.env.GROUP_NAME ?? 'Friends Self Help Group',
    evidenceLevel,
    expected: {
      activeMembers: num(members.rows[0].n),
      obligationsGenerated: num(o.n),
      expectedCents: num(o.expected),
      formulaExpectedCents: num(members.rows[0].n) * rule.monthly_amount_cents,
      settledOnTime: { count: num(o.on_time_n), cents: num(o.on_time) },
      settledLate: { count: num(o.late_n), cents: num(o.late) },
      outstanding: { count: num(o.open_n), cents: num(o.open_amt) },
      confirmedAllocatedCents: num(o.on_time) + num(o.late),
      outstandingSavingsCents: num(o.expected) - (num(o.on_time) + num(o.late)),
    },
    collections: {
      verifiedSavingsCents: num(recv.rows[0].contributions),
      reversedSavingsCents: num(recv.rows[0].reversals),
      allocatedToObligationsCents: num(alloc.rows[0].allocated),
      pendingOrUnmatched: { count: num(held.rows[0].n), cents: num(held.rows[0].amt) },
      pendingSubmissions: { count: num(subs.rows[0].n), cents: num(subs.rows[0].amt) },
      failed: { count: num(failed.rows[0].n), cents: num(failed.rows[0].amt) },
      reversed: { count: num(reversedPay.rows[0].n), cents: num(reversedPay.rows[0].amt) },
    },
    fines: {
      lateAccruedCents: byCat.late_payment ?? 0,
      absenceAccruedCents: byCat.absence ?? 0,
      otherAccruedCents: byCat.other ?? 0,
      verifiedPaymentsCents: num(fineFlows.rows[0].paid),
      waiversAndReversalsCents: num(fineFlows.rows[0].waived),
      outstandingCents: num(fineOut.rows[0].outstanding),
      formulaOutstandingCents: num(fineOut.rows[0].accrued_total) - num(fineOut.rows[0].paid_total) - num(fineOut.rows[0].waived_total),
    },
    position: {
      openingCashCents: opening,
      savingsReceiptsCents: move.savingsReceiptsCents,
      fineCollectionsCents: move.fineCollectionsCents,
      otherIncomeCents: move.otherIncomeCents,
      confirmedIncomeCents: income,
      groupExpenditureCents: move.expenditureCents,
      memberWithdrawalsCents: move.withdrawalsCents,
      confirmedExpenditureCents: expenditure,
      closingCashCents: opening + income - expenditure,
      outstandingObligationsCents: num(o.open_amt),
      totalMemberSavingsCents: savingsBalance,
    },
  };
}

export type ReconSummary = Awaited<ReturnType<typeof computeSummary>>;

// ================================================================ discrepancy detection

interface Check {
  code: string;
  severity: 'material' | 'minor';
  entityType: string;
  sql: string;
}

const CHECKS: Check[] = [
  {
    code: 'PAID_WITHOUT_TRANSACTION', severity: 'material', entityType: 'obligation',
    sql: `SELECT o.id::text AS id, 'Marked paid without a live allocation to a verified transaction: ' || m.membership_no || ' ' || to_char(o.period,'FMMonth YYYY') AS descr
            FROM monthly_obligations o JOIN members m ON m.id = o.member_id
           WHERE o.status IN ('paid','late_paid') AND NOT o.is_historical
             AND NOT EXISTS (SELECT 1 FROM savings_allocations a WHERE a.obligation_id = o.id AND a.reversed_at IS NULL)`,
  },
  {
    code: 'OPEN_BUT_ALLOCATED', severity: 'material', entityType: 'obligation',
    sql: `SELECT o.id::text, 'Obligation shows outstanding but has a live payment allocation: ' || m.membership_no || ' ' || to_char(o.period,'FMMonth YYYY')
            FROM monthly_obligations o JOIN members m ON m.id = o.member_id
           WHERE o.status IN ('unpaid','overdue','not_due')
             AND EXISTS (SELECT 1 FROM savings_allocations a WHERE a.obligation_id = o.id AND a.reversed_at IS NULL)`,
  },
  {
    code: 'ALLOCATION_AMOUNT_MISMATCH', severity: 'material', entityType: 'obligation',
    sql: `SELECT o.id::text, 'Allocated amount differs from the amount due: ' || m.membership_no || ' ' || to_char(o.period,'FMMonth YYYY')
            FROM monthly_obligations o JOIN members m ON m.id = o.member_id
           WHERE o.status IN ('paid','late_paid') AND NOT o.is_historical
             AND (SELECT COALESCE(SUM(a.amount_cents),0) FROM savings_allocations a WHERE a.obligation_id = o.id AND a.reversed_at IS NULL) <> o.amount_due_cents
             AND EXISTS (SELECT 1 FROM savings_allocations a WHERE a.obligation_id = o.id AND a.reversed_at IS NULL)`,
  },
  {
    code: 'CONTRIBUTION_UNALLOCATED', severity: 'material', entityType: 'savings_txn',
    sql: `SELECT t.id::text, 'Savings contribution of KSh ' || (t.amount_cents/100) || ' is not fully allocated to monthly obligations'
            FROM savings_transactions t
           WHERE t.type = 'contribution' AND NOT t.is_historical
             AND t.amount_cents <> (SELECT COALESCE(SUM(a.amount_cents),0) FROM savings_allocations a WHERE a.savings_txn_id = t.id)`,
  },
  {
    code: 'UNALLOCATED_PAYMENT', severity: 'material', entityType: 'payment',
    sql: `SELECT p.id::text, 'M-Pesa payment ' || COALESCE(p.mpesa_receipt,'(no code)') || ' of KSh ' || (p.amount_cents/100) || ' is not allocated to a member'
            FROM payments p WHERE p.status = 'unmatched' OR (p.member_id IS NULL AND p.status <> 'failed' AND p.status <> 'cancelled')`,
  },
  {
    code: 'HELD_PAYMENT', severity: 'minor', entityType: 'payment',
    sql: `SELECT p.id::text, 'Payment ' || COALESCE(p.mpesa_receipt,'(no code)') || ' of KSh ' || (p.amount_cents/100) || ' is held for reconciliation: ' || COALESCE(p.hold_reason,'')
            FROM payments p WHERE p.status = 'held'`,
  },
  {
    code: 'SUBMISSION_ALREADY_RECORDED', severity: 'minor', entityType: 'submission',
    sql: `SELECT s.id::text, 'Submitted M-Pesa code ' || s.mpesa_code || ' already exists as a recorded payment'
            FROM payment_submissions s WHERE s.status IN ('pending','clarification')
             AND EXISTS (SELECT 1 FROM payments p WHERE p.mpesa_receipt = s.mpesa_code)`,
  },
  {
    code: 'DUPLICATE_STATEMENT_REFERENCE', severity: 'material', entityType: 'statement_line',
    sql: `SELECT l.id::text, 'Duplicate M-Pesa reference ' || l.receipt || ' in uploaded statement' FROM statement_lines l WHERE l.match_status = 'duplicate'`,
  },
  {
    code: 'STATEMENT_AMOUNT_MISMATCH', severity: 'material', entityType: 'statement_line',
    sql: `SELECT l.id::text, 'Statement amount for ' || l.receipt || ' (KSh ' || (l.amount_cents/100) || ') differs from the application record' FROM statement_lines l WHERE l.match_status = 'amount_mismatch'`,
  },
  {
    code: 'MISSING_FROM_APPLICATION', severity: 'material', entityType: 'statement_line',
    sql: `SELECT l.id::text, 'M-Pesa statement shows ' || l.receipt || ' (KSh ' || (l.amount_cents/100) || ') but it is missing from the application ledger' FROM statement_lines l WHERE l.match_status = 'unmatched'`,
  },
  {
    code: 'MISSING_FROM_STATEMENT', severity: 'material', entityType: 'payment',
    sql: `SELECT p.id::text, 'Ledger payment ' || p.mpesa_receipt || ' (KSh ' || (p.amount_cents/100) || ') is not in the uploaded M-Pesa statement'
            FROM payments p
           WHERE p.status = 'confirmed' AND NOT p.is_historical AND p.mpesa_receipt IS NOT NULL
             AND EXISTS (SELECT 1 FROM statement_lines s WHERE date_trunc('month', s.txn_time) = date_trunc('month', p.occurred_at))
             AND NOT EXISTS (SELECT 1 FROM statement_lines s WHERE s.receipt = p.mpesa_receipt)`,
  },
  {
    code: 'FINE_RECORDED_AS_SAVINGS', severity: 'material', entityType: 'savings_txn',
    sql: `SELECT t.id::text, 'A fine payment was recorded in the savings ledger (KSh ' || (t.amount_cents/100) || ')'
            FROM savings_transactions t JOIN payments p ON p.id = t.payment_id WHERE p.purpose = 'fine' AND t.type IN ('contribution','historical')`,
  },
  {
    code: 'SAVINGS_RECORDED_AS_FINE', severity: 'material', entityType: 'fine_ledger',
    sql: `SELECT fl.id::text, 'A savings payment was recorded against a fine (KSh ' || (-fl.amount_cents/100) || ')'
            FROM fine_ledger fl JOIN payments p ON p.id = fl.payment_id WHERE p.purpose = 'savings' AND fl.entry_type = 'payment'`,
  },
  {
    code: 'DUPLICATE_FINE', severity: 'material', entityType: 'fine_group',
    sql: `SELECT COALESCE(obligation_id::text, meeting_id::text || ':' || member_id::text), 'Fine charged ' || count(*) || ' times for the same obligation/meeting'
            FROM fines WHERE status <> 'reversed' AND category IN ('late_payment','absence')
           GROUP BY category, obligation_id, meeting_id, member_id HAVING count(*) > 1`,
  },
  {
    code: 'ABSENCE_WITHOUT_FINE', severity: 'material', entityType: 'attendance',
    sql: `SELECT a.meeting_id::text || ':' || a.member_id::text, 'Unexcused absence from "' || mt.title || '" has no absence fine'
            FROM attendance a JOIN meetings mt ON mt.id = a.meeting_id
           WHERE mt.status = 'register_confirmed' AND a.status = 'absent'
             AND NOT EXISTS (SELECT 1 FROM fines f WHERE f.meeting_id = a.meeting_id AND f.member_id = a.member_id AND f.category = 'absence' AND f.status <> 'reversed')`,
  },
  {
    code: 'EXCUSED_WITH_FINE', severity: 'material', entityType: 'attendance',
    sql: `SELECT a.meeting_id::text || ':' || a.member_id::text, 'Approved absence from "' || mt.title || '" has an absence fine'
            FROM attendance a JOIN meetings mt ON mt.id = a.meeting_id
           WHERE a.status IN ('excused','present')
             AND EXISTS (SELECT 1 FROM fines f WHERE f.meeting_id = a.meeting_id AND f.member_id = a.member_id AND f.category = 'absence' AND f.status IN ('outstanding','paid'))`,
  },
  {
    code: 'REVERSAL_NOT_REFLECTED', severity: 'material', entityType: 'payment',
    sql: `SELECT p.id::text, 'Reversed payment ' || COALESCE(p.mpesa_receipt,'') || ' is not fully reflected in the member account'
            FROM payments p
           WHERE p.status = 'reversed'
             AND ( (p.purpose = 'savings' AND (SELECT COALESCE(SUM(t.amount_cents),0) FROM savings_transactions t WHERE t.payment_id = p.id) <> 0)
                OR (p.purpose = 'fine' AND (SELECT COALESCE(SUM(fl.amount_cents),0) FROM fine_ledger fl WHERE fl.payment_id = p.id) <> 0) )`,
  },
  {
    code: 'WITHDRAWAL_WITHOUT_APPROVAL', severity: 'material', entityType: 'withdrawal',
    sql: `SELECT w.id::text, 'Withdrawal ' || w.reference || ' was paid without all required approvals'
            FROM withdrawals w
           WHERE w.status = 'paid'
             AND (SELECT count(*) FROM withdrawal_approvals a WHERE a.withdrawal_id = w.id AND a.decision = 'approved') < array_length(w.required_levels, 1)`,
  },
  {
    code: 'WITHDRAWAL_UNRECORDED', severity: 'material', entityType: 'savings_txn',
    sql: `SELECT t.id::text, 'Savings withdrawal of KSh ' || (-t.amount_cents/100) || ' has no approved withdrawal request'
            FROM savings_transactions t WHERE t.type = 'withdrawal' AND NOT EXISTS (SELECT 1 FROM withdrawals w WHERE w.savings_txn_id = t.id)`,
  },
  {
    code: 'EXPENDITURE_UNSUPPORTED', severity: 'material', entityType: 'expenditure',
    sql: `SELECT e.id::text, 'Expenditure ' || e.reference || ' (KSh ' || (e.amount_cents/100) || ') lacks supporting documentation or approval'
            FROM expenditure e WHERE e.status = 'paid' AND (e.supporting_file_id IS NULL OR e.approved_by IS NULL)`,
  },
  {
    code: 'NEGATIVE_SAVINGS', severity: 'material', entityType: 'member',
    sql: `SELECT m.id::text, 'Member ' || m.membership_no || ' has a negative savings balance'
            FROM members m WHERE (SELECT COALESCE(SUM(amount_cents),0) FROM savings_transactions t WHERE t.member_id = m.id) < 0`,
  },
];

export async function detectDiscrepancies(client: Client, period: string): Promise<number> {
  let added = 0;
  for (const c of CHECKS) {
    const { rows } = await client.query(c.sql);
    for (const r of rows) {
      const ins = await client.query(
        `INSERT INTO discrepancies (period, code, severity, entity_type, entity_id, description)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code, entity_type, entity_id) DO NOTHING RETURNING id`,
        [period, c.code, c.severity, c.entityType, r.id, r.descr ?? r.description ?? r['?column?'] ?? c.code],
      );
      if (ins.rows[0]) added++;
    }
  }
  return added;
}

async function openMaterialCount(db: Db): Promise<number> {
  return num((await db.query(`SELECT count(*) AS n FROM discrepancies WHERE severity = 'material' AND status IN ('unresolved','investigating')`)).rows[0].n);
}

// ================================================================ workflow

async function lockPeriod(client: Client, period: string) {
  await client.query(`INSERT INTO reconciliation_periods (period) VALUES ($1) ON CONFLICT (period) DO NOTHING`, [period]);
  return (await client.query(`SELECT * FROM reconciliation_periods WHERE period = $1 FOR UPDATE`, [period])).rows[0];
}

/** Start (or refresh) a period: detect discrepancies and compute the figures. Closed periods are returned untouched. */
export async function generateReconciliation(client: Client, periodInput: string, opts: { historical?: boolean }, actor: Actor) {
  const period = monthBounds(periodInput);
  const row = await lockPeriod(client, period);
  if (row.status === 'closed') return { period: row, summary: row.snapshot as ReconSummary, newDiscrepancies: 0 };
  const newDiscrepancies = await detectDiscrepancies(client, period);
  const summary = await computeSummary(client, period);
  const open = await openMaterialCount(client);
  const status = row.status === 'awaiting_approval' ? 'awaiting_approval' : open > 0 ? 'discrepancies_found' : 'in_progress';
  const { rows } = await client.query(
    `UPDATE reconciliation_periods
        SET status = $2, evidence_level = $3, is_historical = is_historical OR $4, prepared_by = COALESCE(prepared_by, $5), updated_at = now()
      WHERE period = $1 RETURNING *`,
    [period, status, summary.evidenceLevel, Boolean(opts.historical), actor.userId],
  );
  if (row.status === 'pending') await audit(client, actor, 'reconciliation.created', 'period', period);
  if (newDiscrepancies > 0) await audit(client, actor, 'reconciliation.discrepancies_detected', 'period', period, { after: { newDiscrepancies } });
  return { period: rows[0], summary, newDiscrepancies };
}

export async function updateDiscrepancy(
  client: Client,
  id: number,
  status: 'investigating' | 'resolved' | 'exception',
  note: string,
  actor: Actor & { role: string | null },
  canApproveException: boolean,
) {
  if (!note.trim()) throw new HttpError(400, 'A note documenting the resolution is required');
  if (status === 'exception' && !canApproveException) throw new HttpError(403, 'Only an authorised official can approve an exception');
  const d = (await client.query(`SELECT * FROM discrepancies WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!d) throw new HttpError(404, 'Discrepancy not found');
  const p = (await client.query(`SELECT status FROM reconciliation_periods WHERE period = $1`, [d.period])).rows[0];
  if (p?.status === 'closed') throw new HttpError(409, 'This period is closed. Reopen it to change discrepancies.');
  await client.query(
    `UPDATE discrepancies SET status = $2, resolution_note = $3, resolved_by = $4, resolved_at = CASE WHEN $2 IN ('resolved','exception') THEN now() ELSE NULL END WHERE id = $1`,
    [id, status, note, actor.userId],
  );
  await audit(client, actor, `discrepancy.${status}`, 'discrepancy', String(id), { reason: note, before: { status: d.status } });
}

export async function submitReconciliation(client: Client, periodInput: string, actor: Actor) {
  const period = monthBounds(periodInput);
  const row = await lockPeriod(client, period);
  if (row.status === 'closed') throw new HttpError(409, 'This period is already approved and closed');
  if (row.status === 'awaiting_approval') throw new HttpError(409, 'Already awaiting approval');
  await detectDiscrepancies(client, period);
  const open = await openMaterialCount(client);
  if (open > 0) {
    await client.query(`UPDATE reconciliation_periods SET status = 'discrepancies_found', updated_at = now() WHERE period = $1`, [period]);
    throw new HttpError(409, `${open} material discrepanc${open === 1 ? 'y is' : 'ies are'} unresolved. Resolve each one, or have an authorised official approve a documented exception.`);
  }
  const summary = await computeSummary(client, period);
  await client.query(
    `UPDATE reconciliation_periods SET status = 'awaiting_approval', snapshot = $2, evidence_level = $3, prepared_by = $4, submitted_at = now(), review_note = NULL, updated_at = now() WHERE period = $1`,
    [period, JSON.stringify(summary), summary.evidenceLevel, actor.userId],
  );
  await audit(client, actor, 'reconciliation.submitted', 'period', period, { after: { evidence: summary.evidenceLevel, closingCashCents: summary.position.closingCashCents } });
}

export async function reviewReconciliation(
  client: Client,
  periodInput: string,
  approve: boolean,
  note: string | null,
  actor: Actor & { userId: string; role: string },
) {
  const period = monthBounds(periodInput);
  const row = (await client.query(`SELECT * FROM reconciliation_periods WHERE period = $1 FOR UPDATE`, [period])).rows[0];
  if (!row) throw new HttpError(404, 'Reconciliation not found');
  if (row.status !== 'awaiting_approval') throw new HttpError(409, 'This reconciliation is not awaiting approval');
  if (row.prepared_by === actor.userId && actor.role !== 'super_admin') throw new HttpError(403, 'The preparer cannot approve their own reconciliation');
  if (!approve) {
    if (!note?.trim()) throw new HttpError(400, 'A reason is required to send the reconciliation back');
    await client.query(`UPDATE reconciliation_periods SET status = 'in_progress', review_note = $2, updated_at = now() WHERE period = $1`, [period, note]);
    await audit(client, actor, 'reconciliation.rejected', 'period', period, { reason: note });
    return;
  }
  await detectDiscrepancies(client, period);
  if ((await openMaterialCount(client)) > 0) throw new HttpError(409, 'New material discrepancies were found since submission. Send it back to the treasurer.');
  const summary = await computeSummary(client, period);
  await client.query(
    `UPDATE reconciliation_periods SET status = 'closed', snapshot = $2, evidence_level = $3, reviewed_by = $4, approved_at = now(), review_note = $5, updated_at = now() WHERE period = $1`,
    [period, JSON.stringify(summary), summary.evidenceLevel, actor.userId, note],
  );
  await audit(client, actor, 'reconciliation.approved', 'period', period, { reason: note, after: { evidence: summary.evidenceLevel } });
}

export async function reopenReconciliation(client: Client, periodInput: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new HttpError(400, 'A reason is required to reopen an approved period');
  const period = monthBounds(periodInput);
  const row = (await client.query(`SELECT status FROM reconciliation_periods WHERE period = $1 FOR UPDATE`, [period])).rows[0];
  if (!row || row.status !== 'closed') throw new HttpError(409, 'Only closed periods can be reopened');
  await client.query(`UPDATE reconciliation_periods SET status = 'in_progress', approved_at = NULL, reviewed_by = NULL, updated_at = now() WHERE period = $1`, [period]);
  await audit(client, actor, 'reconciliation.reopened', 'period', period, { reason });
}

/** Where an approved period exists, report from its frozen snapshot so history can never drift. */
export async function getPeriodReport(db: Db, periodInput: string) {
  const period = monthBounds(periodInput);
  const row = (await db.query(`SELECT * FROM reconciliation_periods WHERE period = $1`, [period])).rows[0];
  if (row?.status === 'closed' && row.snapshot) return { row, summary: row.snapshot as ReconSummary, frozen: true };
  return { row: row ?? null, summary: await computeSummary(db, period), frozen: false };
}

export async function memberSchedule(db: Db, periodInput: string) {
  const period = monthBounds(periodInput);
  const { rows } = await db.query(
    `SELECT m.membership_no, m.full_name, o.amount_due_cents, o.status, o.paid_cents, o.paid_at, p.mpesa_receipt,
            f.amount_cents AS late_fine_cents, f.status AS late_fine_status,
            COALESCE((SELECT SUM(amount_cents) FROM fine_ledger fl WHERE fl.member_id = m.id),0) AS fines_outstanding_cents,
            COALESCE((SELECT SUM(amount_cents) FROM savings_transactions t WHERE t.member_id = m.id),0) AS savings_balance_cents
       FROM monthly_obligations o
       JOIN members m ON m.id = o.member_id
       LEFT JOIN payments p ON p.id = o.payment_id
       LEFT JOIN fines f ON f.obligation_id = o.id AND f.category = 'late_payment'
      WHERE o.period = $1::date AND NOT o.is_historical ORDER BY m.membership_no`,
    [period],
  );
  return rows;
}

// ================================================================ M-Pesa statement import & matching

export interface StatementRow {
  receipt: string;
  amountCents: number;
  time: string | null;
  phone: string | null;
  type: string | null;
}

export async function importStatement(client: Client, filename: string, rows: StatementRow[], actor: Actor) {
  if (rows.length === 0) throw new HttpError(400, 'The statement contains no incoming transactions');
  const batch = (await client.query(`INSERT INTO statement_batches (filename, line_count, uploaded_by) VALUES ($1,$2,$3) RETURNING id`, [filename, rows.length, actor.userId])).rows[0].id;
  const seen = new Set<string>();
  const result = { matched: 0, unmatched: 0, duplicate: 0, amountMismatch: 0 };
  for (const r of rows) {
    const receipt = r.receipt.trim().toUpperCase();
    const prior = await client.query(`SELECT 1 FROM statement_lines WHERE receipt = $1 LIMIT 1`, [receipt]);
    let status: 'matched' | 'unmatched' | 'duplicate' | 'amount_mismatch' = 'unmatched';
    let paymentId: string | null = null;
    let note: string | null = null;
    if (seen.has(receipt) || prior.rows[0]) {
      status = 'duplicate';
      note = 'Reference appears more than once across uploaded statements';
    } else {
      const p = (await client.query(`SELECT id, amount_cents, status FROM payments WHERE mpesa_receipt = $1`, [receipt])).rows[0];
      if (p) {
        paymentId = p.id;
        if (p.amount_cents !== r.amountCents) {
          status = 'amount_mismatch';
          note = `Application recorded KSh ${p.amount_cents / 100}`;
        } else {
          status = 'matched';
          if (p.status !== 'confirmed') note = `Matched, but the payment is still ${p.status} in the application`;
        }
      }
    }
    seen.add(receipt);
    await client.query(
      `INSERT INTO statement_lines (batch_id, receipt, amount_cents, txn_time, phone, txn_type, match_status, payment_id, note, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [batch, receipt, r.amountCents, r.time, r.phone ? normalizePhone(r.phone) ?? r.phone : null, r.type, status, paymentId, note, JSON.stringify(r)],
    );
    if (status === 'matched') result.matched++;
    else if (status === 'unmatched') result.unmatched++;
    else if (status === 'duplicate') result.duplicate++;
    else result.amountMismatch++;
  }
  await audit(client, actor, 'statement.imported', 'statement_batch', batch, { after: { filename, ...result } });
  return { batchId: batch as string, ...result };
}

/** Treasurer manually attributes an unmatched statement line to a member. Reason + audit are mandatory. */
export async function manualMatch(
  client: Client,
  lineId: number,
  input: { memberId: string; purpose: 'savings' | 'fine'; fineIds?: string[] },
  reason: string,
  actor: Actor,
) {
  if (!reason.trim()) throw new HttpError(400, 'A reason is required for a manual match');
  const line = (await client.query(`SELECT * FROM statement_lines WHERE id = $1 FOR UPDATE`, [lineId])).rows[0];
  if (!line) throw new HttpError(404, 'Statement line not found');
  if (line.match_status !== 'unmatched') throw new HttpError(409, 'Only unmatched lines can be matched manually');
  const exists = await client.query(`SELECT id FROM payments WHERE mpesa_receipt = $1`, [line.receipt]);
  if (exists.rows[0]) throw new HttpError(409, 'A payment with this reference already exists');
  const p = await client.query(
    `INSERT INTO payments (member_id, purpose, channel, amount_cents, phone, status, mpesa_receipt, fine_ids, occurred_at, created_by)
     VALUES ($1,$2,'manual',$3,$4,'initiated',$5,$6,COALESCE($7::timestamptz, now()),$8) RETURNING id`,
    [input.memberId, input.purpose, line.amount_cents, line.phone, line.receipt, input.fineIds ?? null, line.txn_time, actor.userId],
  );
  const outcome = await confirmPayment(client, p.rows[0].id, actor);
  await client.query(`UPDATE statement_lines SET match_status = 'manual_match', payment_id = $2, note = $3, matched_by = $4 WHERE id = $1`, [lineId, p.rows[0].id, reason, actor.userId]);
  await client.query(
    `UPDATE discrepancies SET status = 'resolved', resolution_note = $2, resolved_by = $3, resolved_at = now()
      WHERE code = 'MISSING_FROM_APPLICATION' AND entity_type = 'statement_line' AND entity_id = $1 AND status <> 'exception'`,
    [String(lineId), `Manually matched: ${reason}`, actor.userId],
  );
  await audit(client, actor, 'statement.manual_match', 'statement_line', String(lineId), { reason, after: { ...input, outcome: outcome.outcome } });
  return outcome;
}

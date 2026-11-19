import type pg from 'pg';
import { audit, type Actor } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { ensureLateFine, isAdminManaged, todayEAT } from './obligations.js';

type Client = pg.PoolClient;

export interface PaymentRow {
  id: string;
  member_id: string | null;
  purpose: 'savings' | 'fine';
  amount_cents: number;
  status: string;
  mpesa_receipt: string | null;
  fine_ids: string[] | null;
  obligation_ids: string[] | null;
  occurred_at: string | null;
  receipt_no: string | null;
  hold_reason: string | null;
  is_historical: boolean;
}

export type ApplyOutcome =
  | { outcome: 'confirmed'; paymentId: string; receiptNo: string; allocations: { obligationId: string; period: string; amountCents: number; late: boolean }[] }
  | { outcome: 'fines_paid'; paymentId: string; receiptNo: string; fineIds: string[] }
  | { outcome: 'already_confirmed'; paymentId: string }
  | { outcome: 'held'; paymentId: string; reason: string };

const kes = (cents: number) => `KSh ${(cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/** Serialises every money movement for one member. All allocation work happens under this lock. */
export async function lockMember(client: Client, memberId: string): Promise<void> {
  const { rowCount } = await client.query(`SELECT id FROM members WHERE id = $1 FOR UPDATE`, [memberId]);
  if (!rowCount) throw new HttpError(404, 'Member not found');
}

async function lockPayment(client: Client, paymentId: string): Promise<PaymentRow> {
  const { rows } = await client.query(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
  if (!rows[0]) throw new HttpError(404, 'Payment not found');
  return rows[0];
}

async function hold(client: Client, p: PaymentRow, status: 'held' | 'unmatched', reason: string, actor: Actor): Promise<ApplyOutcome> {
  await client.query(`UPDATE payments SET status = $2, hold_reason = $3 WHERE id = $1`, [p.id, status, reason]);
  await audit(client, actor, `payment.${status}`, 'payment', p.id, { reason, after: { amountCents: p.amount_cents } });
  return { outcome: 'held', paymentId: p.id, reason };
}

async function finalisePayment(client: Client, p: PaymentRow, actor: Actor): Promise<string> {
  const { rows } = await client.query(
    `UPDATE payments
        SET status = 'confirmed', hold_reason = NULL, confirmed_at = now(), confirmed_by = $2,
            occurred_at = COALESCE(occurred_at, now()),
            receipt_no = COALESCE(receipt_no, 'RCT-' || lpad(nextval('receipt_no_seq')::text, 6, '0'))
      WHERE id = $1 RETURNING receipt_no`,
    [p.id, actor.userId],
  );
  return rows[0].receipt_no;
}

/**
 * Confirm a payment that has been verified (Daraja callback success, or treasurer approval).
 * Idempotent: confirming an already-confirmed payment is a no-op, so repeated callbacks can never
 * create duplicate ledger entries.
 */
export async function confirmPayment(client: Client, paymentId: string, actor: Actor): Promise<ApplyOutcome> {
  const p = await lockPayment(client, paymentId);
  if (p.status === 'confirmed') return { outcome: 'already_confirmed', paymentId: p.id };
  if (!['initiated', 'held', 'unmatched'].includes(p.status)) {
    throw new HttpError(409, `A ${p.status} payment cannot be confirmed`);
  }
  if (!p.member_id) return hold(client, p, 'unmatched', 'Payment is not linked to a member', actor);
  await lockMember(client, p.member_id);
  return p.purpose === 'savings' ? applySavings(client, p, actor) : applyFines(client, p, actor);
}

async function applySavings(client: Client, p: PaymentRow, actor: Actor): Promise<ApplyOutcome> {
  const memberId = p.member_id!;
  // The administrator can name the exact invoices a payment settles; otherwise it settles the oldest outstanding months first.
  const named = p.obligation_ids && p.obligation_ids.length > 0 ? [...new Set(p.obligation_ids)] : null;
  if (!named && (await isAdminManaged(client))) return hold(client, p, 'held', 'Waiting for the administrator to choose which invoices this payment settles', actor);
  const { rows: open } = await client.query(
    `SELECT * FROM monthly_obligations
      WHERE member_id = $1 AND status IN ('unpaid', 'overdue', 'not_due') AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      ORDER BY period ASC FOR UPDATE`,
    [memberId, named],
  );
  if (named && open.length !== named.length) {
    return hold(client, p, 'held', 'One of the chosen invoices is no longer open (already paid or changed)', actor);
  }

  // Only whole months are ever settled.
  let remaining = p.amount_cents;
  const picks: typeof open = [];
  if (named) {
    for (const o of open) { picks.push(o); remaining -= o.amount_due_cents; }
  } else {
    for (const o of open) {
      if (remaining >= o.amount_due_cents) {
        picks.push(o);
        remaining -= o.amount_due_cents;
      } else break;
    }
  }

  if (open.length === 0) {
    return hold(client, p, 'held', 'Member has no outstanding monthly contribution to allocate this payment to', actor);
  }
  if (picks.length === 0) {
    return hold(
      client, p, 'held',
      `Underpayment: ${kes(p.amount_cents)} is less than the ${kes(open[0].amount_due_cents)} due for the oldest outstanding month. Partial contributions are not accepted.`,
      actor,
    );
  }
  if (remaining !== 0) {
    return hold(
      client, p, 'held',
      `Amount ${kes(p.amount_cents)} does not equal a whole number of outstanding monthly contributions (${kes(remaining)} left over)`,
      actor,
    );
  }

  const paidOn: string = (
    await client.query(`SELECT (COALESCE($1::timestamptz, now()) AT TIME ZONE 'Africa/Nairobi')::date AS d`, [p.occurred_at])
  ).rows[0].d;
  const today = await todayEAT(client);

  const txn = await client.query(
    `INSERT INTO savings_transactions (member_id, type, amount_cents, payment_id, reference, is_historical, occurred_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()), $8) RETURNING id`,
    [memberId, p.is_historical ? 'historical' : 'contribution', p.amount_cents, p.id, p.mpesa_receipt, p.is_historical, p.occurred_at, actor.userId],
  );
  const txnId: string = txn.rows[0].id;

  const allocations: { obligationId: string; period: string; amountCents: number; late: boolean }[] = [];
  for (const o of picks) {
    const late = paidOn > o.due_date;
    await client.query(
      `UPDATE monthly_obligations
          SET status = $2, paid_cents = amount_due_cents, paid_at = COALESCE($3::timestamptz, now()), payment_id = $4
        WHERE id = $1`,
      [o.id, late ? 'late_paid' : 'paid', p.occurred_at, p.id],
    );
    await client.query(
      `INSERT INTO savings_allocations (savings_txn_id, obligation_id, amount_cents) VALUES ($1, $2, $3)`,
      [txnId, o.id, o.amount_due_cents],
    );
    // A late contribution does NOT settle its fine; it only guarantees the fine exists, once.
    if (late) await ensureLateFine(client, o.id, today > paidOn ? today : paidOn);
    allocations.push({ obligationId: o.id, period: o.period, amountCents: o.amount_due_cents, late });
  }

  const receiptNo = await finalisePayment(client, p, actor);
  await audit(client, actor, 'payment.confirmed', 'payment', p.id, {
    after: { purpose: 'savings', amountCents: p.amount_cents, months: allocations.map((a) => a.period), receiptNo },
  });
  return { outcome: 'confirmed', paymentId: p.id, receiptNo, allocations };
}

async function applyFines(client: Client, p: PaymentRow, actor: Actor): Promise<ApplyOutcome> {
  const memberId = p.member_id!;
  let fines: { id: string; amount_cents: number }[];

  if (!(p.fine_ids && p.fine_ids.length > 0) && (await isAdminManaged(client))) return hold(client, p, 'held', 'Waiting for the administrator to choose which fines this payment settles', actor);
  if (p.fine_ids && p.fine_ids.length > 0) {
    const ids = [...new Set(p.fine_ids)];
    const { rows } = await client.query(
      `SELECT id, amount_cents FROM fines WHERE id = ANY($1::uuid[]) AND member_id = $2 AND status = 'outstanding' ORDER BY imposed_on, created_at FOR UPDATE`,
      [ids, memberId],
    );
    if (rows.length !== ids.length) {
      return hold(client, p, 'held', 'One or more selected fines are not outstanding for this member', actor);
    }
    fines = rows;
    const total = fines.reduce((s, f) => s + f.amount_cents, 0);
    if (total !== p.amount_cents) {
      return hold(client, p, 'held', `Amount ${kes(p.amount_cents)} does not equal the selected fines total of ${kes(total)}`, actor);
    }
  } else {
    // No explicit selection: settle oldest outstanding fines first, whole fines only.
    const { rows } = await client.query(
      `SELECT id, amount_cents FROM fines WHERE member_id = $1 AND status = 'outstanding' ORDER BY imposed_on, created_at FOR UPDATE`,
      [memberId],
    );
    let remaining = p.amount_cents;
    fines = [];
    for (const f of rows) {
      if (remaining >= f.amount_cents) {
        fines.push(f);
        remaining -= f.amount_cents;
      } else break;
    }
    if (fines.length === 0 || remaining !== 0) {
      return hold(client, p, 'held', `Amount ${kes(p.amount_cents)} does not match whole outstanding fines`, actor);
    }
  }

  for (const f of fines) {
    await client.query(
      `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, payment_id, note)
       VALUES ($1, $2, 'payment', $3, $4, 'Fine payment')`,
      [f.id, memberId, -f.amount_cents, p.id],
    );
    await client.query(`UPDATE fines SET status = 'paid', paid_payment_id = $2, paid_at = now() WHERE id = $1`, [f.id, p.id]);
  }
  const receiptNo = await finalisePayment(client, p, actor);
  await audit(client, actor, 'payment.confirmed', 'payment', p.id, {
    after: { purpose: 'fine', amountCents: p.amount_cents, fines: fines.map((f) => f.id), receiptNo },
  });
  return { outcome: 'fines_paid', paymentId: p.id, receiptNo, fineIds: fines.map((f) => f.id) };
}

/** Mark a payment as failed or cancelled (e.g. STK push rejected, user dismissed the prompt). */
export async function failPayment(
  client: Client,
  paymentId: string,
  status: 'failed' | 'cancelled',
  resultCode: number | null,
  resultDesc: string | null,
  actor: Actor,
): Promise<void> {
  const p = await lockPayment(client, paymentId);
  if (p.status !== 'initiated') return; // never downgrade a confirmed/held payment
  await client.query(`UPDATE payments SET status = $2, result_code = $3, result_desc = $4 WHERE id = $1`, [paymentId, status, resultCode, resultDesc]);
  await audit(client, actor, `payment.${status}`, 'payment', paymentId, { reason: resultDesc });
}

/**
 * Reverse a confirmed payment. Nothing is erased: a reversing ledger entry is appended, allocations
 * are marked reversed, and obligations/fines return to their outstanding state.
 */
export async function reversePayment(client: Client, paymentId: string, reason: string, actor: Actor): Promise<void> {
  if (!reason.trim()) throw new HttpError(400, 'A reason is required to reverse a payment');
  const p = await lockPayment(client, paymentId);
  if (p.status !== 'confirmed') throw new HttpError(409, 'Only confirmed payments can be reversed');
  if (!p.member_id) throw new HttpError(409, 'Payment has no member');
  await lockMember(client, p.member_id);
  const today = await todayEAT(client);

  if (p.purpose === 'savings') {
    const { rows: txns } = await client.query(
      `SELECT * FROM savings_transactions WHERE payment_id = $1 AND amount_cents > 0 AND type IN ('contribution','historical') FOR UPDATE`,
      [p.id],
    );
    const bal = (await client.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE member_id = $1`, [p.member_id])).rows[0].b;
    const total = txns.reduce((s, t) => s + t.amount_cents, 0);
    if (bal - total < 0) {
      throw new HttpError(409, 'Reversing this payment would make the savings balance negative. Reverse the related withdrawal first.');
    }
    for (const t of txns) {
      await client.query(
        `INSERT INTO savings_transactions (member_id, type, amount_cents, payment_id, reverses_id, reference, reason, is_historical, created_by)
         VALUES ($1,'reversal',$2,$3,$4,$5,$6,$7,$8)`,
        [p.member_id, -t.amount_cents, p.id, t.id, t.reference, reason, t.is_historical, actor.userId],
      );
      const { rows: allocs } = await client.query(
        `UPDATE savings_allocations SET reversed_at = now() WHERE savings_txn_id = $1 AND reversed_at IS NULL RETURNING obligation_id`,
        [t.id],
      );
      for (const a of allocs) {
        await client.query(
          `UPDATE monthly_obligations
              SET status = CASE WHEN period > $2::date THEN 'not_due'::obligation_status
                                WHEN due_date < $2::date THEN 'overdue'::obligation_status
                                ELSE 'unpaid'::obligation_status END,
                  paid_cents = 0, paid_at = NULL, payment_id = NULL
            WHERE id = $1`,
          [a.obligation_id, today],
        );
      }
    }
  } else {
    const { rows: entries } = await client.query(
      `SELECT fine_id, member_id, amount_cents FROM fine_ledger WHERE payment_id = $1 AND entry_type = 'payment'`,
      [p.id],
    );
    for (const e of entries) {
      await client.query(
        `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, payment_id, note, created_by)
         VALUES ($1,$2,'payment_reversal',$3,$4,$5,$6)`,
        [e.fine_id, e.member_id, -e.amount_cents, p.id, reason, actor.userId],
      );
      await client.query(`UPDATE fines SET status = 'outstanding', paid_payment_id = NULL, paid_at = NULL WHERE id = $1`, [e.fine_id]);
    }
  }

  await client.query(`UPDATE payments SET status = 'reversed', hold_reason = $2 WHERE id = $1`, [p.id, reason]);
  await audit(client, actor, 'payment.reversed', 'payment', p.id, { reason, after: { amountCents: p.amount_cents } });
}

// ---------------------------------------------------------------- fines

export async function imposeFine(
  client: Client,
  input: { memberId: string; category: 'absence' | 'other'; amountCents: number; reason: string; meetingId?: string | null },
  actor: Actor,
): Promise<string> {
  if (!input.reason.trim()) throw new HttpError(400, 'A reason is required');
  const { rows } = await client.query(
    `INSERT INTO fines (reference, member_id, category, amount_cents, reason, meeting_id, created_by)
     VALUES ('FN-' || lpad(nextval('fine_ref_seq')::text, 6, '0'), $1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.memberId, input.category, input.amountCents, input.reason, input.meetingId ?? null, actor.userId],
  );
  await client.query(
    `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,'charge',$3,$4,$5)`,
    [rows[0].id, input.memberId, input.amountCents, input.reason, actor.userId],
  );
  await audit(client, actor, 'fine.imposed', 'fine', rows[0].id, { reason: input.reason, after: input });
  return rows[0].id;
}

/** Waive (forgive) or reverse (charged in error) an outstanding fine. Never deletes it. */
export async function resolveFine(
  client: Client,
  fineId: string,
  kind: 'waiver' | 'reversal',
  reason: string,
  actor: Actor,
): Promise<void> {
  if (!reason.trim()) throw new HttpError(400, 'A reason is required');
  const { rows } = await client.query(`SELECT * FROM fines WHERE id = $1 FOR UPDATE`, [fineId]);
  const f = rows[0];
  if (!f) throw new HttpError(404, 'Fine not found');
  if (f.status !== 'outstanding') throw new HttpError(409, `Only outstanding fines can be ${kind === 'waiver' ? 'waived' : 'reversed'}`);
  await client.query(
    `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [f.id, f.member_id, kind, -f.amount_cents, reason, actor.userId],
  );
  await client.query(
    `UPDATE fines SET status = $2, resolution_note = $3, resolved_by = $4 WHERE id = $1`,
    [f.id, kind === 'waiver' ? 'waived' : 'reversed', reason, actor.userId],
  );
  await audit(client, actor, `fine.${kind}`, 'fine', f.id, { reason, before: { status: f.status }, after: { amountCents: f.amount_cents } });
}

// ---------------------------------------------------------------- read models

export async function getMemberSummary(db: pg.Pool | Client, memberId: string) {
  const today = await todayEAT(db);
  const [sav, ob, fin, last, nextDue, pending, fy] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(amount_cents),0) AS balance FROM savings_transactions WHERE member_id = $1`, [memberId]),
    db.query(
      `SELECT COALESCE(SUM(amount_due_cents) FILTER (WHERE NOT is_historical),0) AS expected,
              COALESCE(SUM(amount_due_cents) FILTER (WHERE status IN ('unpaid','overdue')),0) AS outstanding,
              COUNT(*) FILTER (WHERE status IN ('unpaid','overdue')) AS outstanding_months
         FROM monthly_obligations WHERE member_id = $1`,
      [memberId],
    ),
    db.query(
      `SELECT COALESCE(SUM(amount_cents) FILTER (WHERE entry_type = 'charge'),0) AS accrued,
              COALESCE(-SUM(amount_cents) FILTER (WHERE entry_type IN ('payment','payment_reversal')),0) AS paid,
              COALESCE(-SUM(amount_cents) FILTER (WHERE entry_type IN ('waiver','reversal')),0) AS waived,
              COALESCE(SUM(amount_cents),0) AS outstanding
         FROM fine_ledger WHERE member_id = $1`,
      [memberId],
    ),
    db.query(
      `SELECT id, receipt_no, purpose, amount_cents, confirmed_at FROM payments
        WHERE member_id = $1 AND status = 'confirmed' ORDER BY confirmed_at DESC LIMIT 1`,
      [memberId],
    ),
    db.query(
      `SELECT MIN(due_date) AS d FROM monthly_obligations WHERE member_id = $1 AND status IN ('unpaid','overdue')`,
      [memberId],
    ),
    db.query(`SELECT COUNT(*) AS n FROM payments WHERE member_id = $1 AND status IN ('initiated','held')`, [memberId]),
    db.query(
      `SELECT COALESCE(SUM(st.amount_cents),0) AS s FROM savings_transactions st, financial_years fy
        WHERE st.member_id = $1 AND fy.is_current AND (st.occurred_at AT TIME ZONE 'Africa/Nairobi')::date BETWEEN fy.start_date AND fy.end_date`,
      [memberId],
    ),
  ]);
  return {
    asOf: today,
    savings: {
      balanceCents: sav.rows[0].balance,
      currentYearCents: fy.rows[0].s,
      expectedCents: ob.rows[0].expected,
      outstandingCents: ob.rows[0].outstanding,
      outstandingMonths: Number(ob.rows[0].outstanding_months),
    },
    fines: {
      accruedCents: fin.rows[0].accrued,
      paidCents: fin.rows[0].paid,
      waivedCents: fin.rows[0].waived,
      outstandingCents: fin.rows[0].outstanding,
    },
    payments: {
      last: last.rows[0] ?? null,
      oldestOutstandingDueDate: nextDue.rows[0].d,
      pendingVerification: Number(pending.rows[0].n),
    },
  };
}

export async function getReceipt(db: pg.Pool | Client, paymentId: string) {
  const { rows } = await db.query(
    `SELECT p.*, m.full_name, m.membership_no FROM payments p LEFT JOIN members m ON m.id = p.member_id WHERE p.id = $1`,
    [paymentId],
  );
  const p = rows[0];
  if (!p) throw new HttpError(404, 'Payment not found');
  const allocations = (
    await db.query(
      `SELECT o.period, a.amount_cents, a.reversed_at, o.status AS obligation_status
         FROM savings_transactions st
         JOIN savings_allocations a ON a.savings_txn_id = st.id
         JOIN monthly_obligations o ON o.id = a.obligation_id
        WHERE st.payment_id = $1 AND st.amount_cents > 0 ORDER BY o.period`,
      [paymentId],
    )
  ).rows;
  const fines = (
    await db.query(
      `SELECT f.reference, f.category, f.reason, -fl.amount_cents AS amount_cents
         FROM fine_ledger fl JOIN fines f ON f.id = fl.fine_id WHERE fl.payment_id = $1 AND fl.entry_type = 'payment'`,
      [paymentId],
    )
  ).rows;
  return { payment: p, allocations, fines };
}

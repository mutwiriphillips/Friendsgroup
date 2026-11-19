import type { PoolClient } from 'pg';
import { HttpError } from '../lib/http.js';
import { monthName } from '../lib/dates.js';
import { audit, type Actor } from '../lib/audit.js';
import { dueDateFor, ensureFinancialYear, ruleAt, todayEAT } from './obligations.js';
import { resolveFine, reversePayment } from './ledger.js';
import { creditBalance } from './invoices.js';
import { undoAllocationEntry } from './manualPayments.js';

const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const monthLabel = monthName;
const need = (note: string | undefined) => { if (!note || note.trim().length < 3) throw new HttpError(400, 'Say why you are making this correction'); return note.trim(); };

export interface FineCorrection { imposedOn?: string; period?: string; reason?: string; amountKsh?: number; note: string }

/**
 * The administrator corrects a fine that was recorded wrongly: its date, the month it belongs to, its wording, or (while still unpaid) its amount.
 * Nothing is overwritten silently: the old and new values go to the audit trail with the reason, and an amount change adds a ledger entry.
 */
export async function correctFine(c: PoolClient, fineId: string, input: FineCorrection, actor: Actor) {
  const note = need(input.note);
  const f = (await c.query(`SELECT * FROM fines WHERE id = $1 FOR UPDATE`, [fineId])).rows[0];
  if (!f) throw new HttpError(404, 'Fine not found');
  if (f.status === 'reversed') throw new HttpError(409, 'This fine was reversed and can no longer be changed');
  const before = { imposedOn: f.imposed_on as string, period: f.period as string | null, reason: f.reason as string, amountCents: Number(f.amount_cents) };
  const today = await todayEAT(c);

  if (input.imposedOn !== undefined) {
    if (!isDate(input.imposedOn)) throw new HttpError(400, 'Enter a valid date');
    if (input.imposedOn > today) throw new HttpError(400, 'The date cannot be in the future');
    await c.query(`UPDATE fines SET imposed_on = $2::date WHERE id = $1`, [fineId, input.imposedOn]);
  }
  if (input.reason !== undefined) {
    if (input.reason.trim().length < 3) throw new HttpError(400, 'The description is too short');
    await c.query(`UPDATE fines SET reason = $2 WHERE id = $1`, [fineId, input.reason.trim()]);
  }
  if (input.period !== undefined) {
    const period = `${input.period.slice(0, 7)}-01`;
    if (!/^\d{4}-\d{2}-01$/.test(period)) throw new HttpError(400, 'Choose a valid month');
    if (f.category === 'late_payment') {
      const ob = (await c.query(`SELECT id FROM monthly_obligations WHERE member_id = $1 AND period = $2::date`, [f.member_id, period])).rows[0];
      const dup = (await c.query(
        `SELECT 1 FROM fines WHERE member_id = $1 AND category = 'late_payment' AND status <> 'reversed' AND id <> $4 AND ((obligation_id IS NOT NULL AND obligation_id = $3) OR (obligation_id IS NULL AND period = $2::date))`,
        [f.member_id, period, ob?.id ?? null, fineId])).rows[0];
      if (dup) throw new HttpError(409, `This member already has a late fine for ${monthLabel(period)}`);
      await c.query(`UPDATE fines SET period = $2::date, obligation_id = $3 WHERE id = $1`, [fineId, period, ob?.id ?? null]);
    } else {
      await c.query(`UPDATE fines SET period = $2::date WHERE id = $1`, [fineId, period]);
    }
  }
  if (input.amountKsh !== undefined) {
    const cents = Math.round(input.amountKsh * 100);
    if (!(cents > 0)) throw new HttpError(400, 'The amount must be more than zero');
    if (cents !== Number(f.amount_cents)) {
      if (f.status !== 'outstanding') throw new HttpError(409, `This fine is ${f.status}, so its amount cannot be changed. Reverse it and raise a new one instead.`);
      const delta = cents - Number(f.amount_cents);
      await c.query(
        `INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [fineId, f.member_id, delta > 0 ? 'charge' : 'waiver', delta, `Correction: ${note}`, actor.userId]);
      await c.query(`UPDATE fines SET amount_cents = $2 WHERE id = $1`, [fineId, cents]);
    }
  }
  const a = (await c.query(`SELECT imposed_on::text AS imposed_on, period::text AS period, reason, amount_cents FROM fines WHERE id = $1`, [fineId])).rows[0];
  const after = { imposedOn: a.imposed_on as string, period: a.period as string | null, reason: a.reason as string, amountCents: Number(a.amount_cents) };
  await audit(c, actor, 'fine.corrected', 'fine', fineId, { reason: note, before, after });
  return after;
}

export interface InvoiceCorrection { dueDate?: string; period?: string; amountKsh?: number; note: string }

/** Corrects a contribution invoice that has not been paid: its month, its due date or its amount. */
export async function correctContributionInvoice(c: PoolClient, obligationId: string, input: InvoiceCorrection, actor: Actor) {
  const note = need(input.note);
  const o = (await c.query(`SELECT * FROM monthly_obligations WHERE id = $1 FOR UPDATE`, [obligationId])).rows[0];
  if (!o) throw new HttpError(404, 'Invoice not found');
  if (o.status === 'paid' || o.status === 'late_paid') throw new HttpError(409, 'This invoice is already paid, so it cannot be changed.');
  const before = { period: o.period as string, dueDate: o.due_date as string, amountCents: Number(o.amount_due_cents) };
  const today = await todayEAT(c);
  let period = o.period as string;
  if (input.period !== undefined) {
    period = `${input.period.slice(0, 7)}-01`;
    if (!isDate(period)) throw new HttpError(400, 'Choose a valid month');
    if (period !== (o.period as string)) {
      const clash = (await c.query(`SELECT 1 FROM monthly_obligations WHERE member_id = $1 AND period = $2::date AND id <> $3`, [o.member_id, period, obligationId])).rows[0];
      if (clash) throw new HttpError(409, `This member already has an invoice for ${monthLabel(period)}`);
    }
  }
  const due = input.dueDate ?? (period !== (o.period as string) ? dueDateFor(period, Number((o.due_date as string).slice(8, 10)), (await ruleAt(c, period)).due_month_offset) : (o.due_date as string));
  if (!isDate(due)) throw new HttpError(400, 'Enter a valid date');
  const cents = input.amountKsh === undefined ? Number(o.amount_due_cents) : Math.round(input.amountKsh * 100);
  if (!(cents > 0)) throw new HttpError(400, 'The amount must be more than zero');
  const status = today < period ? 'not_due' : today <= due ? 'unpaid' : 'overdue';
  await c.query(`UPDATE monthly_obligations SET period = $5::date, due_date = $2::date, amount_due_cents = $3, status = $4::obligation_status WHERE id = $1`, [obligationId, due, cents, status, period]);
  await audit(c, actor, 'invoice.corrected', 'member', o.member_id, { reason: note, before, after: { period, dueDate: due, amountCents: cents, status } });
  return { period, dueDate: due, amountCents: cents, status };
}

export interface ManualPaymentCorrection { paidOn?: string; message?: string; note: string }

/** Corrects the date or the pasted message on a payment the administrator keyed in. The money already posted is not moved. */
export async function correctManualPayment(c: PoolClient, id: string, input: ManualPaymentCorrection, actor: Actor) {
  const note = need(input.note);
  const m = (await c.query(`SELECT * FROM manual_payments WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!m) throw new HttpError(404, 'Payment record not found');
  const today = await todayEAT(c);
  const before = { paidOn: m.paid_on as string | null, message: m.transaction_message as string };
  if (input.paidOn !== undefined) {
    if (!isDate(input.paidOn)) throw new HttpError(400, 'Enter a valid date');
    if (input.paidOn > today) throw new HttpError(400, 'The payment date cannot be in the future');
    await c.query(`UPDATE manual_payments SET paid_on = $2::date WHERE id = $1`, [id, input.paidOn]);
  }
  if (input.message !== undefined) {
    if (input.message.trim().length < 10) throw new HttpError(400, 'The message is too short');
    await c.query(`UPDATE manual_payments SET transaction_message = $2 WHERE id = $1`, [id, input.message.trim()]);
  }
  const a = (await c.query(`SELECT paid_on::text AS paid_on, transaction_message FROM manual_payments WHERE id = $1`, [id])).rows[0];
  await audit(c, actor, 'payment.corrected', 'member', m.member_id, { reason: note, before, after: { paidOn: a.paid_on, message: a.transaction_message } });
  return { paidOn: a.paid_on as string, message: a.transaction_message as string };
}

/**
 * Reverses a payment the administrator keyed in by mistake (wrong amount, wrong member's money, wrong month...). Nothing is deleted:
 * the savings and fine entries it made are reversed, the invoices it cleared are open again, any overpayment credit it created is taken back,
 * and the record stays in the list marked as reversed. The M-Pesa code can then be entered again correctly.
 */
export async function reverseManualPayment(c: PoolClient, id: string, input: { note: string }, actor: Actor) {
  const note = need(input.note);
  const m = (await c.query(`SELECT * FROM manual_payments WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!m) throw new HttpError(404, 'Payment record not found');
  if (m.reversed_at) throw new HttpError(409, 'This payment was already reversed');
  let over = 0;
  if (m.payment_id || m.penalty_payment_id) {
    // payments entered before allocation was the administrator's choice: they were posted straight to invoices
    over = Number((await c.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM member_credits WHERE manual_payment_id = $1`, [id])).rows[0].s);
    if (over > 0 && (await creditBalance(c, m.member_id)) < over) {
      throw new HttpError(409, 'Part of the overpayment from this payment has already been applied to invoices. The credit left is less than the overpayment, so this payment cannot be reversed here.');
    }
    for (const pid of [m.payment_id, m.penalty_payment_id].filter(Boolean) as string[]) await reversePayment(c, pid, note, actor);
  } else {
    // every allocation made from this payment is undone, then whatever money remains on it is taken off the account
    const live = (await c.query(
      `SELECT mc.* FROM member_credits mc WHERE mc.manual_payment_id = $1 AND mc.entry_type = 'applied' AND mc.allocation ? 'paymentIds'
          AND NOT EXISTS (SELECT 1 FROM member_credits r WHERE r.entry_type = 'reinstated' AND (r.allocation->>'undoes')::bigint = mc.id) ORDER BY mc.id`, [id])).rows;
    for (const e of live) await undoAllocationEntry(c, e, note, actor);
    over = Number((await c.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM member_credits WHERE manual_payment_id = $1`, [id])).rows[0].s);
  }
  if (over > 0) {
    await c.query(
      `INSERT INTO member_credits (member_id, entry_type, amount_cents, manual_payment_id, note, created_by) VALUES ($1,'adjustment',$2,$3,$4,$5)`,
      [m.member_id, -over, id, `Money taken back: payment reversed (${note})`, actor.userId]);
  }
  await c.query(`UPDATE manual_payments SET reversed_at = now(), reversed_reason = $2 WHERE id = $1`, [id, note]);
  await audit(c, actor, 'payment.manual_reversed', 'member', m.member_id, { reason: note, before: { amountCents: Number(m.amount_cents), mpesaCode: m.mpesa_code, paidOn: m.paid_on }, after: { reversed: true } });
  return { reversed: true, amountCents: Number(m.amount_cents), overpaymentTakenBackCents: over };
}

export interface MeetingCorrection { title?: string; scheduledAt?: string; venue?: string; agenda?: string; note: string }

/** Corrects a meeting's title, date and time, venue or agenda. Attendance and fines already recorded stay as they are. */
export async function correctMeeting(c: PoolClient, id: string, input: MeetingCorrection, actor: Actor) {
  const note = need(input.note);
  const m = (await c.query(`SELECT * FROM meetings WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!m) throw new HttpError(404, 'Meeting not found');
  const before = { title: m.title as string, scheduledAt: new Date(m.scheduled_at).toISOString(), venue: m.venue as string, agenda: m.agenda as string | null };
  if (input.title !== undefined && input.title.trim().length < 3) throw new HttpError(400, 'The title is too short');
  if (input.venue !== undefined && input.venue.trim().length < 2) throw new HttpError(400, 'The venue is too short');
  let when: string | null = null; let fy: number | null = null;
  if (input.scheduledAt !== undefined) {
    const t = new Date(input.scheduledAt);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'Enter a valid date and time');
    when = t.toISOString();
    fy = await ensureFinancialYear(c, `${t.toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' })}`);
  }
  await c.query(
    `UPDATE meetings SET title = COALESCE($2, title), venue = COALESCE($3, venue), agenda = CASE WHEN $4::boolean THEN $5 ELSE agenda END,
            scheduled_at = COALESCE($6::timestamptz, scheduled_at), financial_year_id = COALESCE($7, financial_year_id) WHERE id = $1`,
    [id, input.title?.trim() ?? null, input.venue?.trim() ?? null, input.agenda !== undefined, input.agenda?.trim() || null, when, fy]);
  const a = (await c.query(`SELECT title, scheduled_at, venue, agenda FROM meetings WHERE id = $1`, [id])).rows[0];
  const after = { title: a.title as string, scheduledAt: new Date(a.scheduled_at).toISOString(), venue: a.venue as string, agenda: a.agenda as string | null };
  await audit(c, actor, 'meeting.corrected', 'meeting', id, { reason: note, before, after });
  return after;
}

/**
 * Clears fines so they can be posted afresh: every fine that is still outstanding (for one member, or for everyone) is reversed with a reason.
 * Nothing is deleted, the audit trail keeps each one. Fines that are already paid are left alone, because money was received for them:
 * reverse the payment first (member profile, "Entered by hand") if those should go too.
 */
export async function clearFines(c: PoolClient, input: { memberId?: string; note: string }, actor: Actor) {
  const note = need(input.note);
  const rows = (await c.query(
    `SELECT id FROM fines WHERE status = 'outstanding' AND ($1::uuid IS NULL OR member_id = $1) ORDER BY created_at`, [input.memberId ?? null])).rows;
  for (const r of rows) await resolveFine(c, r.id, 'reversal', `Cleared to post afresh: ${note}`, actor);
  const kept = Number((await c.query(`SELECT count(*) AS n FROM fines WHERE status = 'paid' AND ($1::uuid IS NULL OR member_id = $1)`, [input.memberId ?? null])).rows[0].n);
  await audit(c, actor, 'fines.cleared', input.memberId ? 'member' : 'all', input.memberId ?? 'all', { reason: note, after: { cleared: rows.length, paidKept: kept } });
  return { cleared: rows.length, paidKept: kept };
}

import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { monthName } from '../lib/dates.js';
import { HttpError } from '../lib/http.js';
import { audit, type Actor } from '../lib/audit.js';
import { dueDateFor, ensureFinancialYear, isAdminManaged, ruleAt, todayEAT } from './obligations.js';

export type InvoiceKind = 'contribution' | 'late_fine' | 'meeting_fine' | 'other_fine';
export interface OpenInvoice { kind: InvoiceKind; id: string; month: string; amountCents: number; label: string; dueDate: string | null; upcoming: boolean }
export interface PaymentPlan {
  applied: OpenInvoice[];
  future: { period: string; amountCents: number }[];
  contributionCents: number;
  penaltyCents: number;
  leftoverCents: number;
  note: string | null;
}
export type PayFor = 'auto' | 'contribution' | 'penalty';

const MAX_FUTURE_MONTHS = 36;
const kes = (c: number) => `KSh ${(c / 100).toLocaleString('en-KE')}`;
const monthLabel = monthName;
const addMonths = (p: string, n: number) => { const d = new Date(`${p.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };

/** Everything the member owes, earliest to latest: contributions, late fines, meeting fines (same month: in that order). */
export async function openInvoices(db: Db, memberId: string, lock = false): Promise<OpenInvoice[]> {
  const today = await todayEAT(db);
  const lk = lock ? 'FOR UPDATE OF o' : '';
  const lkf = lock ? 'FOR UPDATE OF f' : '';
  const contrib = (await db.query(
    `SELECT o.id, o.period::text AS month, o.amount_due_cents AS amount, o.due_date::text AS due, o.status::text AS status
       FROM monthly_obligations o WHERE o.member_id = $1 AND o.status IN ('unpaid','overdue','not_due') ${lk}`, [memberId])).rows;
  const fines = (await db.query(
    `SELECT f.id, f.category::text AS category, f.amount_cents AS amount, f.reason, f.imposed_on::text AS imposed_on, f.created_at,
            COALESCE(ob.period, f.period, date_trunc('month', f.imposed_on)::date)::text AS month
       FROM fines f LEFT JOIN monthly_obligations ob ON ob.id = f.obligation_id
      WHERE f.member_id = $1 AND f.status = 'outstanding' ${lkf}`, [memberId])).rows;
  const rank: Record<InvoiceKind, number> = { contribution: 0, late_fine: 1, meeting_fine: 2, other_fine: 3 };
  const out: (OpenInvoice & { at: string })[] = [
    ...contrib.map((o) => ({ kind: 'contribution' as const, id: o.id as string, month: o.month as string, amountCents: Number(o.amount), label: `Contribution, ${monthLabel(o.month)}`, dueDate: o.due as string, upcoming: o.status === 'not_due' || (o.due as string) >= today && o.status !== 'overdue' && o.month > today, at: '' })),
    ...fines.map((f) => {
      const kind: InvoiceKind = f.category === 'late_payment' ? 'late_fine' : f.category === 'absence' ? 'meeting_fine' : 'other_fine';
      return { kind, id: f.id as string, month: f.month as string, amountCents: Number(f.amount), label: f.reason as string, dueDate: f.imposed_on as string, upcoming: false, at: String(f.created_at) };
    }),
  ];
  out.sort((a, b) => a.month.localeCompare(b.month) || rank[a.kind] - rank[b.kind] || a.at.localeCompare(b.at));
  return out.map(({ at: _at, ...rest }) => rest);
}

export async function creditBalance(db: Db, memberId: string): Promise<number> {
  return Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM member_credits WHERE member_id = $1`, [memberId])).rows[0].b);
}

export async function owedSummary(db: Db, memberId: string) {
  const inv = await openInvoices(db, memberId);
  const sum = (f: (i: OpenInvoice) => boolean) => inv.filter(f).reduce((a, i) => a + i.amountCents, 0);
  const contributionsCents = sum((i) => i.kind === 'contribution' && !i.upcoming);
  const penaltiesCents = sum((i) => i.kind !== 'contribution');
  return { contributionsCents, penaltiesCents, totalCents: contributionsCents + penaltiesCents, upcomingCents: sum((i) => i.kind === 'contribution' && i.upcoming), creditCents: await creditBalance(db, memberId), invoices: inv };
}

/** Works out where a payment would go, without writing anything. Payments settle whole invoices, earliest first. */
export async function planPayment(db: Db, memberId: string, amountCents: number, payFor: PayFor, lock = false, allowFuture = true): Promise<PaymentPlan> {
  const all = await openInvoices(db, memberId, lock);
  const eligible = all.filter((i) => (payFor === 'contribution' ? i.kind === 'contribution' : payFor === 'penalty' ? i.kind !== 'contribution' : true));
  let rem = amountCents;
  const applied: OpenInvoice[] = [];
  for (const i of eligible) { if (rem >= i.amountCents) { applied.push(i); rem -= i.amountCents; } else break; }
  const exhausted = applied.length === eligible.length;
  const future: PaymentPlan['future'] = [];
  let note: string | null = null;
  if (allowFuture && exhausted && rem > 0 && payFor !== 'penalty') {
    const today = await todayEAT(db);
    const thisMonth = `${today.slice(0, 7)}-01`;
    const last = (await db.query(`SELECT MAX(period)::text AS p FROM monthly_obligations WHERE member_id = $1`, [memberId])).rows[0].p as string | null;
    let period = last && addMonths(last, 1) > thisMonth ? addMonths(last, 1) : thisMonth;
    while (future.length < MAX_FUTURE_MONTHS) {
      const rule = await ruleAt(db, period);
      if (rem < rule.monthly_amount_cents) break;
      future.push({ period, amountCents: rule.monthly_amount_cents });
      rem -= rule.monthly_amount_cents;
      period = addMonths(period, 1);
    }
  }
  if (rem > 0) {
    const next = eligible[applied.length];
    note = next
      ? `${kes(rem)} would be left over: the next invoice (${next.label}) is ${kes(next.amountCents)}. Payments must clear whole invoices.`
      : payFor === 'penalty' ? `${kes(rem)} is more than the penalties owed. Choose “Auto” to roll the rest into future contributions.`
      : `${kes(rem)} would be left over. Contributions are paid in whole months (${kes(future[0]?.amountCents ?? 150000)} each).`;
  }
  const contributionCents = applied.filter((i) => i.kind === 'contribution').reduce((a, i) => a + i.amountCents, 0) + future.reduce((a, f) => a + f.amountCents, 0);
  const penaltyCents = applied.filter((i) => i.kind !== 'contribution').reduce((a, i) => a + i.amountCents, 0);
  return { applied, future, contributionCents, penaltyCents, leftoverCents: rem, note };
}

/** What the administrator chose to pay: named open invoices, plus a number of months in advance. Nothing is written. */
export async function planSelection(db: Db, memberId: string, ids: { contributionIds?: string[]; fineIds?: string[]; advanceMonths?: number }, lock = false): Promise<PaymentPlan> {
  const all = await openInvoices(db, memberId, lock);
  const want = new Set([...(ids.contributionIds ?? []), ...(ids.fineIds ?? [])]);
  const applied = all.filter((i) => want.has(i.id));
  if (applied.length !== want.size) throw new HttpError(409, 'One of the chosen invoices is no longer open. Refresh and choose again.');
  const future: PaymentPlan['future'] = [];
  const n = Math.max(0, Math.min(MAX_FUTURE_MONTHS, Math.floor(ids.advanceMonths ?? 0)));
  if (n > 0) {
    const today = await todayEAT(db);
    const thisMonth = `${today.slice(0, 7)}-01`;
    const last = (await db.query(`SELECT MAX(period)::text AS p FROM monthly_obligations WHERE member_id = $1`, [memberId])).rows[0].p as string | null;
    let period = last && addMonths(last, 1) > thisMonth ? addMonths(last, 1) : thisMonth;
    for (let k = 0; k < n; k++) {
      const rule = await ruleAt(db, period);
      future.push({ period, amountCents: rule.monthly_amount_cents });
      period = addMonths(period, 1);
    }
  }
  const contributionCents = applied.filter((i) => i.kind === 'contribution').reduce((a, i) => a + i.amountCents, 0) + future.reduce((a, f) => a + f.amountCents, 0);
  const penaltyCents = applied.filter((i) => i.kind !== 'contribution').reduce((a, i) => a + i.amountCents, 0);
  return { applied, future, contributionCents, penaltyCents, leftoverCents: 0, note: null };
}

/** Creates the contribution invoices for months paid in advance. */
export async function createFutureInvoices(c: PoolClient, memberId: string, future: PaymentPlan['future']): Promise<string[]> {
  const today = await todayEAT(c);
  const managed = await isAdminManaged(c);
  const ids: string[] = [];
  for (const f of future) {
    const rule = await ruleAt(c, f.period);
    const fy = await ensureFinancialYear(c, f.period);
    const due = dueDateFor(f.period, rule.deadline_day, rule.due_month_offset);
    const status = managed ? 'unpaid' : today < f.period ? 'not_due' : today <= due ? 'unpaid' : 'overdue';
    const r = await c.query(
      `INSERT INTO monthly_obligations (member_id, financial_year_id, period, amount_due_cents, due_date, late_fine_cents, status, rule_version_id)
       VALUES ($1,$2,$3::date,$4,$5::date,$6,$7::obligation_status,$8) ON CONFLICT (member_id, period) DO NOTHING RETURNING id`,
      [memberId, fy, f.period, rule.monthly_amount_cents, due, rule.late_fine_cents, status, rule.id]);
    if (!r.rows[0]) throw new HttpError(409, `${monthLabel(f.period)} is already invoiced; try again`);
    ids.push(r.rows[0].id as string);
  }
  return ids;
}

export interface RaiseInput { memberId?: string; allMembers?: boolean; kind: 'contribution' | 'late_fine' | 'meeting_fine'; period?: string; meetingId?: string; amountKsh?: number; lateFineApplies?: boolean; note?: string }

/** The administrator raises an invoice: what the member owes the group for a month. */
export async function raiseInvoice(c: PoolClient, input: RaiseInput, actor: Actor) {
  const today = await todayEAT(c);
  const cents = input.amountKsh === undefined ? null : Math.round(input.amountKsh * 100);
  if (cents !== null && cents <= 0) throw new HttpError(400, 'The amount must be more than zero');

  if (input.kind === 'contribution') {
    if (!input.period) throw new HttpError(400, 'Choose the month');
    const period = `${input.period.slice(0, 7)}-01`;
    const rule = await ruleAt(c, period);
    const fy = await ensureFinancialYear(c, period);
    const due = dueDateFor(period, rule.deadline_day, rule.due_month_offset);
    const status = (await isAdminManaged(c)) ? 'unpaid' : today < period ? 'not_due' : today <= due ? 'unpaid' : 'overdue';
    const lateFine = input.lateFineApplies === false ? 0 : rule.late_fine_cents;
    const members = input.allMembers
      ? (await c.query(`SELECT id FROM members WHERE status = 'active'`)).rows.map((r) => r.id as string)
      : [input.memberId ?? (() => { throw new HttpError(400, 'Choose a member'); })()];
    let created = 0;
    for (const id of members) {
      const r = await c.query(
        `INSERT INTO monthly_obligations (member_id, financial_year_id, period, amount_due_cents, due_date, late_fine_cents, status, rule_version_id)
         VALUES ($1,$2,$3::date,$4,$5::date,$6,$7::obligation_status,$8) ON CONFLICT (member_id, period) DO NOTHING RETURNING id`,
        [id, fy, period, cents ?? rule.monthly_amount_cents, due, lateFine, status, rule.id]);
      created += r.rows.length;
    }
    if (!input.allMembers && created === 0) throw new HttpError(409, `This member already has a contribution invoice for ${monthLabel(period)}`);
    await audit(c, actor, 'invoice.raised', 'member', input.memberId ?? null, { after: { kind: 'contribution', period, amountCents: cents ?? rule.monthly_amount_cents, created, allMembers: !!input.allMembers } });
    return { created };
  }

  if (!input.memberId) throw new HttpError(400, 'Choose a member');
  const member = (await c.query(`SELECT id FROM members WHERE id = $1`, [input.memberId])).rows[0];
  if (!member) throw new HttpError(404, 'Member not found');

  if (input.kind === 'late_fine') {
    if (!input.period) throw new HttpError(400, 'Choose the month the late fine is for');
    const period = `${input.period.slice(0, 7)}-01`;
    const rule = await ruleAt(c, period);
    const ob = (await c.query(`SELECT id FROM monthly_obligations WHERE member_id = $1 AND period = $2::date`, [input.memberId, period])).rows[0];
    const dup = (await c.query(
      `SELECT 1 FROM fines WHERE member_id = $1 AND category = 'late_payment' AND status <> 'reversed' AND ((obligation_id IS NOT NULL AND obligation_id = $3) OR (obligation_id IS NULL AND period = $2::date))`,
      [input.memberId, period, ob?.id ?? null])).rows[0];
    if (dup) throw new HttpError(409, `A late fine for ${monthLabel(period)} already exists for this member`);
    // a fine that was cleared (reversed) still holds the obligation's single late-fine slot: the new one is tied to the month instead
    const slotTaken = ob ? (await c.query(`SELECT 1 FROM fines WHERE obligation_id = $1 AND category = 'late_payment'`, [ob.id])).rows[0] : null;
    const amount = cents ?? rule.late_fine_cents;
    const imposed = new Date(Date.parse(`${dueDateFor(period, rule.deadline_day, rule.due_month_offset)}T00:00:00Z`) + 864e5).toISOString().slice(0, 10); // the day after the deadline
    const f = (await c.query(
      `INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, obligation_id, period, created_by)
       VALUES ('FN-' || lpad(nextval('fine_ref_seq')::text, 6, '0'), $1,'late_payment',$2,$3::date,$4,$5,$6::date,$7) RETURNING id`,
      [input.memberId, amount, imposed, `Late contribution fine, ${monthLabel(period)}${input.note ? ` (${input.note})` : ''}`, slotTaken ? null : ob?.id ?? null, period, actor.userId])).rows[0];
    await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,'charge',$3,'Invoice raised by administrator',$4)`, [f.id, input.memberId, amount, actor.userId]);
    await audit(c, actor, 'invoice.raised', 'member', input.memberId, { after: { kind: 'late_fine', period, amountCents: amount } });
    return { created: 1 };
  }

  // missing-meeting fine
  if (!input.meetingId) throw new HttpError(400, 'Choose the meeting that was missed');
  const mt = (await c.query(`SELECT id, title, (scheduled_at AT TIME ZONE 'Africa/Nairobi')::date::text AS d FROM meetings WHERE id = $1`, [input.meetingId])).rows[0];
  if (!mt) throw new HttpError(404, 'Meeting not found');
  const dup = (await c.query(`SELECT 1 FROM fines WHERE meeting_id = $1 AND member_id = $2 AND category = 'absence' AND status <> 'reversed'`, [input.meetingId, input.memberId])).rows[0];
  if (dup) throw new HttpError(409, 'This member already has a fine for that meeting');
  const rule = await ruleAt(c, mt.d);
  const amount = cents ?? rule.absence_fine_cents;
  const f = (await c.query(
    `INSERT INTO fines (reference, member_id, category, amount_cents, imposed_on, reason, meeting_id, created_by)
     VALUES ('FN-' || lpad(nextval('fine_ref_seq')::text, 6, '0'), $1,'absence',$2,$3::date,$4,$5,$6) RETURNING id`,
    [input.memberId, amount, mt.d, `Missed meeting: ${mt.title} (${mt.d})${input.note ? ` (${input.note})` : ''}`, input.meetingId, actor.userId])).rows[0];
  await c.query(`INSERT INTO fine_ledger (fine_id, member_id, entry_type, amount_cents, note, created_by) VALUES ($1,$2,'charge',$3,'Invoice raised by administrator',$4)`, [f.id, input.memberId, amount, actor.userId]);
  await c.query(`INSERT INTO attendance (meeting_id, member_id, status, updated_by) VALUES ($1,$2,'absent',$3) ON CONFLICT (meeting_id, member_id) DO UPDATE SET status = 'absent', updated_at = now()`, [input.meetingId, input.memberId, actor.userId]);
  await audit(c, actor, 'invoice.raised', 'member', input.memberId, { after: { kind: 'meeting_fine', meetingId: input.meetingId, amountCents: amount } });
  return { created: 1 };
}

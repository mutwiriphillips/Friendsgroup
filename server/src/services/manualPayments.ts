import type { PoolClient } from 'pg';
import type { Db } from '../db/pool.js';
import { HttpError } from '../lib/http.js';
import { audit, type Actor } from '../lib/audit.js';
import { confirmPayment, lockMember } from './ledger.js';
import { todayEAT } from './obligations.js';
import { createFutureInvoices, creditBalance, planSelection, type PaymentPlan } from './invoices.js';
import { reversePayment } from './ledger.js';

export interface ManualPaymentInput { memberId: string; amountKsh: number; message: string; mpesaCode?: string; paidOn?: string }
export interface AllocateInput { memberId: string; manualPaymentId: string; contributionIds?: string[]; fineIds?: string[]; advanceMonths?: number; note?: string }

/** Finds the M-Pesa transaction code (10 characters, letters and digits) in a pasted confirmation message. */
export function extractMpesaCode(message: string): string | null {
  const m = message.toUpperCase().match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{10}\b/);
  return m ? m[0] : null;
}

/** Posts the contribution part and the penalty part of a plan as payments in their own ledgers. Shared by payments and credit applications. */
async function postPlan(c: PoolClient, memberId: string, plan: PaymentPlan, code: string, at: string, historical: boolean, actor: Actor) {
  const futureIds = await createFutureInvoices(c, memberId, plan.future);
  const obligationIds = [...plan.applied.filter((i) => i.kind === 'contribution').map((i) => i.id), ...futureIds];
  const receipts: string[] = []; let savingsPaymentId: string | null = null; let finePaymentId: string | null = null;
  if (plan.contributionCents > 0) {
    const p = (await c.query(
      `INSERT INTO payments (member_id, purpose, channel, amount_cents, status, mpesa_receipt, obligation_ids, occurred_at, is_historical, created_by)
       VALUES ($1,'savings','manual',$2,'initiated',$3,$4,$5::timestamptz,$6,$7) RETURNING id`, [memberId, plan.contributionCents, code, obligationIds, at, historical, actor.userId])).rows[0];
    const out = await confirmPayment(c, p.id, actor);
    if (out.outcome !== 'confirmed') throw new HttpError(400, out.outcome === 'held' ? out.reason : 'The contribution part could not be applied');
    const wanted = plan.applied.filter((i) => i.kind === 'contribution').length + plan.future.length;
    if (out.allocations.length !== wanted) throw new HttpError(409, 'The invoices changed while posting. Please try again.');
    savingsPaymentId = p.id; receipts.push(out.receiptNo);
  }
  if (plan.penaltyCents > 0) {
    const fineIds = plan.applied.filter((i) => i.kind !== 'contribution').map((i) => i.id);
    const p = (await c.query(
      `INSERT INTO payments (member_id, purpose, channel, amount_cents, status, mpesa_receipt, fine_ids, occurred_at, is_historical, created_by)
       VALUES ($1,'fine','manual',$2,'initiated',$3,$4,$5::timestamptz,$6,$7) RETURNING id`,
      [memberId, plan.penaltyCents, savingsPaymentId ? `${code}-P` : code, fineIds, at, historical, actor.userId])).rows[0];
    const out = await confirmPayment(c, p.id, actor);
    if (out.outcome !== 'fines_paid') throw new HttpError(400, out.outcome === 'held' ? out.reason : 'The penalty part could not be applied');
    finePaymentId = p.id; receipts.push(out.receiptNo);
  }
  return { receipts, savingsPaymentId, finePaymentId };
}

const describe = (plan: PaymentPlan) => ({
  cleared: plan.applied.map((i) => ({ kind: i.kind, label: i.label, month: i.month, amountCents: i.amountCents })),
  inAdvance: plan.future.map((f) => ({ period: f.period, amountCents: f.amountCents })),
  contributionCents: plan.contributionCents, penaltyCents: plan.penaltyCents,
});

/**
 * The administrator posts money received from a member. Nothing is allocated automatically: the money is recorded against the member
 * (with the M-Pesa message and date) and waits as "received, not yet allocated" until the administrator approves which invoices it pays.
 */
export async function recordManualPayment(c: PoolClient, input: ManualPaymentInput, actor: Actor) {
  const message = input.message.trim();
  if (message.length < 10) throw new HttpError(400, 'Paste the full M-Pesa transaction message');
  const code = input.mpesaCode?.trim().toUpperCase() || extractMpesaCode(message);
  if (!code) throw new HttpError(400, 'Could not find the M-Pesa code in the message. Type it in the code box.');
  if (!/^[A-Z0-9]{8,14}$/.test(code)) throw new HttpError(400, 'The M-Pesa code should be letters and digits only');
  const cents = Math.round(input.amountKsh * 100);
  if (!(cents > 0)) throw new HttpError(400, 'Enter the amount paid');
  const today = await todayEAT(c);
  const paidOn = input.paidOn || today;
  if (paidOn > today) throw new HttpError(400, 'The payment date cannot be in the future');

  await lockMember(c, input.memberId);
  const member = (await c.query(`SELECT id, full_name FROM members WHERE id = $1`, [input.memberId])).rows[0];
  if (!member) throw new HttpError(404, 'Member not found');
  // A code is free again once the payment that used it has been reversed.
  const dup = (await c.query(
    `SELECT 1 FROM payments WHERE status <> 'reversed' AND mpesa_receipt ~ ('^' || $1 || '(-R[0-9]+)?(-[AP][0-9]*)*$')
     UNION ALL SELECT 1 FROM manual_payments WHERE mpesa_code = $1 AND reversed_at IS NULL`, [code])).rows[0];
  if (dup) throw new HttpError(409, `The M-Pesa code ${code} is already recorded`, 'DUPLICATE_RECEIPT');

  const row = (await c.query(
    `INSERT INTO manual_payments (member_id, amount_cents, period, transaction_message, mpesa_code, route, recorded_by, kind, paid_on, allocation)
     VALUES ($1,$2,NULL,$3,$4,'unallocated',$5,'auto',$6::date,$7) RETURNING id`,
    [input.memberId, cents, message, code, actor.userId, paidOn, JSON.stringify({ awaitingAllocation: true })])).rows[0];
  await c.query(
    `INSERT INTO member_credits (member_id, entry_type, amount_cents, manual_payment_id, note, created_by) VALUES ($1,'received',$2,$3,$4,$5)`,
    [input.memberId, cents, row.id, `Payment received, M-Pesa ${code}`, actor.userId]);
  await audit(c, actor, 'payment.manual_entry', 'member', input.memberId, { after: { amountCents: cents, mpesaCode: code, paidOn } });
  return { id: row.id as string, mpesaCode: code, member: member.full_name as string, receivedCents: cents, balanceCents: await creditBalance(c, input.memberId) };
}

export interface HeldPayment { id: string; mpesaCode: string; paidOn: string; amountCents: number; balanceCents: number }

/** Money received by hand that is still waiting for the administrator to allocate it, payment by payment (oldest first). */
export async function heldPayments(db: Db, memberId: string): Promise<HeldPayment[]> {
  const pays = (await db.query(
    `SELECT id, mpesa_code, paid_on::text AS paid_on, amount_cents FROM manual_payments WHERE member_id = $1 AND reversed_at IS NULL ORDER BY created_at`, [memberId])).rows;
  const linked = new Map<string, number>((await db.query(
    `SELECT manual_payment_id AS id, SUM(amount_cents) AS s FROM member_credits WHERE member_id = $1 AND manual_payment_id IS NOT NULL GROUP BY manual_payment_id`, [memberId]))
    .rows.map((r) => [r.id as string, Number(r.s)]));
  // credit used before payments were tracked one by one counts against the oldest payments first
  let legacy = -Number((await db.query(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM member_credits WHERE member_id = $1 AND manual_payment_id IS NULL`, [memberId])).rows[0].s);
  const out: HeldPayment[] = [];
  for (const p of pays) {
    let bal = linked.get(p.id as string) ?? 0;
    if (legacy > 0 && bal > 0) { const take = Math.min(legacy, bal); bal -= take; legacy -= take; }
    if (bal > 0) out.push({ id: p.id, mpesaCode: p.mpesa_code, paidOn: p.paid_on, amountCents: Number(p.amount_cents), balanceCents: bal });
  }
  return out;
}


/** What approving this choice would do, without writing anything. */
export async function planAllocation(c: Db, input: AllocateInput) {
  const held = (await heldPayments(c, input.memberId)).find((h) => h.id === input.manualPaymentId);
  const plan = await planSelection(c, input.memberId, input);
  const total = plan.contributionCents + plan.penaltyCents;
  return { balanceCents: held?.balanceCents ?? 0, totalCents: total, plan, enough: total > 0 && total <= (held?.balanceCents ?? 0) };
}

/**
 * The administrator approves which invoices a received payment pays: any open invoices he ticks (contributions, late fines, meeting fines)
 * and, if wanted, a number of future months. Whole invoices only. What is not used stays on that payment for later. The payment is
 * dated the day the money was received, so the late-payment rules look at that date, not at the day of approval.
 */
export async function allocatePayment(c: PoolClient, input: AllocateInput, actor: Actor) {
  await lockMember(c, input.memberId);
  const member = (await c.query(`SELECT id, full_name FROM members WHERE id = $1`, [input.memberId])).rows[0];
  if (!member) throw new HttpError(404, 'Member not found');
  const mp = (await c.query(`SELECT id, mpesa_code, paid_on::text AS paid_on FROM manual_payments WHERE id = $1 AND member_id = $2 AND reversed_at IS NULL`, [input.manualPaymentId, input.memberId])).rows[0];
  if (!mp) throw new HttpError(404, 'Payment not found for this member');
  const held = (await heldPayments(c, input.memberId)).find((h) => h.id === mp.id);
  if (!held) throw new HttpError(400, 'This payment has no money left to allocate');

  const plan = await planSelection(c, input.memberId, input, true);
  const total = plan.contributionCents + plan.penaltyCents;
  if (total <= 0) throw new HttpError(400, 'Choose at least one invoice to pay');
  if (total > held.balanceCents) throw new HttpError(400, `The chosen invoices come to KSh ${(total / 100).toLocaleString('en-KE')}, but this payment only has KSh ${(held.balanceCents / 100).toLocaleString('en-KE')} left`);

  const today = await todayEAT(c);
  let base = `${mp.mpesa_code}-A1`;
  for (let n = 1; ; n++) {
    base = `${mp.mpesa_code}-A${n}`;
    if (!(await c.query(`SELECT 1 FROM payments WHERE mpesa_receipt IN ($1, $2)`, [base, `${base}-P`])).rows[0]) break;
  }
  const historical = (mp.paid_on as string).slice(0, 7) < today.slice(0, 7);
  const posted = await postPlan(c, input.memberId, plan, base, `${mp.paid_on}T12:00:00+03:00`, historical, actor);
  const allocation = { ...describe(plan), paymentIds: [posted.savingsPaymentId, posted.finePaymentId].filter(Boolean) };
  await c.query(
    `INSERT INTO member_credits (member_id, entry_type, amount_cents, manual_payment_id, note, allocation, created_by) VALUES ($1,'applied',$2,$3,$4,$5,$6)`,
    [input.memberId, -total, mp.id, input.note?.trim() || null, JSON.stringify(allocation), actor.userId]);
  await audit(c, actor, 'payment.allocated', 'member', input.memberId, { after: { amountCents: total, source: mp.mpesa_code, note: input.note ?? null, ...allocation } });
  return { member: member.full_name as string, receipts: posted.receipts, balanceCents: await creditBalance(c, input.memberId), paymentLeftCents: held.balanceCents - total, source: mp.mpesa_code as string, ...allocation };
}

/** Takes an allocation back: the payments it made are reversed (invoices open again) and the money returns to the received payment. */
export async function undoAllocationEntry(c: PoolClient, entry: { id: number; member_id: string; manual_payment_id: string; amount_cents: number; allocation: { paymentIds?: string[] } | null }, note: string, actor: Actor) {
  for (const pid of entry.allocation?.paymentIds ?? []) await reversePayment(c, pid, note, actor);
  await c.query(
    `INSERT INTO member_credits (member_id, entry_type, amount_cents, manual_payment_id, note, allocation, created_by) VALUES ($1,'reinstated',$2,$3,$4,$5,$6)`,
    [entry.member_id, -Number(entry.amount_cents), entry.manual_payment_id, `Allocation undone: ${note}`, JSON.stringify({ undoes: entry.id }), actor.userId]);
}

export async function undoAllocation(c: PoolClient, entryId: number, input: { note: string }, actor: Actor) {
  const note = input.note.trim();
  if (note.length < 3) throw new HttpError(400, 'Say why (a few words) so the audit trail explains it');
  const e = (await c.query(`SELECT * FROM member_credits WHERE id = $1 FOR UPDATE`, [entryId])).rows[0];
  if (!e || e.entry_type !== 'applied' || !e.manual_payment_id) throw new HttpError(404, 'Allocation not found');
  await lockMember(c, e.member_id);
  const done = (await c.query(`SELECT 1 FROM member_credits WHERE entry_type = 'reinstated' AND (allocation->>'undoes')::bigint = $1`, [entryId])).rows[0];
  if (done) throw new HttpError(409, 'This allocation was already undone');
  await undoAllocationEntry(c, e, note, actor);
  await audit(c, actor, 'payment.allocation_undone', 'member', e.member_id, { reason: note, before: { amountCents: -Number(e.amount_cents), allocation: e.allocation } });
  return { undone: true, amountCents: -Number(e.amount_cents) };
}

export async function creditHistory(c: Db, memberId: string) {
  const rows = (await c.query(
    `SELECT mc.id, mc.entry_type, mc.amount_cents, mc.note, mc.allocation, mc.created_at, u.email AS by, mp.mpesa_code,
            (mc.entry_type = 'applied' AND NOT EXISTS (SELECT 1 FROM member_credits r WHERE r.entry_type = 'reinstated' AND (r.allocation->>'undoes')::bigint = mc.id)
              AND mc.allocation ? 'paymentIds') AS undoable
       FROM member_credits mc LEFT JOIN users u ON u.id = mc.created_by LEFT JOIN manual_payments mp ON mp.id = mc.manual_payment_id
      WHERE mc.member_id = $1 ORDER BY mc.id DESC`, [memberId])).rows;
  return { balanceCents: await creditBalance(c, memberId), payments: await heldPayments(c, memberId), entries: rows };
}

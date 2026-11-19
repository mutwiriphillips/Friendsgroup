import type pg from 'pg';
import { audit, SYSTEM_ACTOR, type Actor } from '../lib/audit.js';
import { HttpError } from '../lib/http.js';
import { normalizePhone } from '../lib/phone.js';
import { confirmPayment, failPayment, type ApplyOutcome } from './ledger.js';
import { notifyMember } from './notifications.js';

type Client = pg.PoolClient;

export interface PaymentPlan {
  purpose: 'savings' | 'fine';
  amountCents: number;
  description: string;
  periods?: string[];
  fineIds?: string[];
}

/**
 * Works out what a member is paying for. The member can choose HOW MANY months, never WHICH months:
 * savings always cover the oldest outstanding months first.
 */
export async function planMemberPayment(
  db: pg.Pool | Client,
  memberId: string,
  req: { purpose: 'savings' | 'fine'; months?: number; fineIds?: string[] },
): Promise<PaymentPlan> {
  if (req.purpose === 'savings') {
    const months = req.months ?? 1;
    if (!Number.isInteger(months) || months < 1) throw new HttpError(400, 'Choose how many months to pay');
    const { rows } = await db.query(
      `SELECT period, amount_due_cents FROM monthly_obligations
        WHERE member_id = $1 AND status IN ('unpaid','overdue') ORDER BY period LIMIT $2`,
      [memberId, months],
    );
    if (rows.length === 0) throw new HttpError(409, 'You have no outstanding monthly contributions');
    if (rows.length < months) throw new HttpError(409, `You only have ${rows.length} outstanding month(s)`);
    return {
      purpose: 'savings',
      amountCents: rows.reduce((s, r) => s + r.amount_due_cents, 0),
      description: `Savings ${rows.length}m`,
      periods: rows.map((r) => r.period),
    };
  }
  const ids = [...new Set(req.fineIds ?? [])];
  if (ids.length === 0) throw new HttpError(400, 'Select at least one fine to pay');
  const { rows } = await db.query(
    `SELECT id, amount_cents FROM fines WHERE id = ANY($1::uuid[]) AND member_id = $2 AND status = 'outstanding'`,
    [ids, memberId],
  );
  if (rows.length !== ids.length) throw new HttpError(409, 'One or more selected fines are not outstanding');
  return { purpose: 'fine', amountCents: rows.reduce((s, r) => s + r.amount_cents, 0), description: 'Fine payment', fineIds: ids };
}

/** Inserts the pending payment row after Safaricom accepted the STK prompt. */
export async function recordInitiatedStk(
  client: Client,
  input: { memberId: string; plan: PaymentPlan; phone: string; checkoutRequestId: string; merchantRequestId: string; userId: string },
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO payments (member_id, purpose, channel, amount_cents, phone, status, checkout_request_id, merchant_request_id, fine_ids, created_by)
     VALUES ($1,$2,'stk_push',$3,$4,'initiated',$5,$6,$7,$8) RETURNING id`,
    [input.memberId, input.plan.purpose, input.plan.amountCents, input.phone, input.checkoutRequestId, input.merchantRequestId, input.plan.fineIds ?? null, input.userId],
  );
  return rows[0].id;
}

interface StkCallbackBody {
  Body?: {
    stkCallback?: {
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      ResultCode?: number;
      ResultDesc?: string;
      CallbackMetadata?: { Item?: { Name: string; Value?: string | number }[] };
    };
  };
}

function meta(items: { Name: string; Value?: string | number }[] | undefined, name: string) {
  return items?.find((i) => i.Name === name)?.Value;
}

/**
 * Processes a Daraja STK callback. Safe to receive any number of times: the payment row is locked and
 * a payment that has already left 'initiated' is never processed again.
 */
export async function processStkCallback(client: Client, body: StkCallbackBody): Promise<{ handled: boolean }> {
  const cb = body.Body?.stkCallback;
  if (!cb?.CheckoutRequestID) return { handled: false };
  const { rows } = await client.query(`SELECT * FROM payments WHERE checkout_request_id = $1 FOR UPDATE`, [cb.CheckoutRequestID]);
  const p = rows[0];
  if (!p) {
    await audit(client, SYSTEM_ACTOR, 'mpesa.callback_unknown_checkout', 'checkout', cb.CheckoutRequestID, { after: cb });
    return { handled: false };
  }
  if (p.status !== 'initiated') return { handled: true }; // duplicate callback

  await client.query(`UPDATE payments SET raw_callback = $2, result_code = $3, result_desc = $4 WHERE id = $1`, [
    p.id, JSON.stringify(body), cb.ResultCode ?? null, cb.ResultDesc ?? null,
  ]);

  if (cb.ResultCode !== 0) {
    const status = cb.ResultCode === 1032 ? 'cancelled' : 'failed';
    await failPayment(client, p.id, status, cb.ResultCode ?? null, cb.ResultDesc ?? null, SYSTEM_ACTOR);
    if (p.member_id) await notifyMember(client, p.member_id, 'payment_failed', 'Payment not completed', `Your M-Pesa payment of KSh ${p.amount_cents / 100} was ${status === 'cancelled' ? 'cancelled' : 'not completed'}. ${cb.ResultDesc ?? ''}`.trim());
    return { handled: true };
  }

  const items = cb.CallbackMetadata?.Item;
  const receipt = String(meta(items, 'MpesaReceiptNumber') ?? '').toUpperCase();
  const amount = Number(meta(items, 'Amount') ?? 0);
  const rawTime = String(meta(items, 'TransactionDate') ?? '');
  // TransactionDate is YYYYMMDDHHmmss in East Africa Time.
  const occurredAt = /^\d{14}$/.test(rawTime)
    ? `${rawTime.slice(0, 4)}-${rawTime.slice(4, 6)}-${rawTime.slice(6, 8)}T${rawTime.slice(8, 10)}:${rawTime.slice(10, 12)}:${rawTime.slice(12, 14)}+03:00`
    : null;

  if (!receipt) {
    await client.query(`UPDATE payments SET status = 'held', hold_reason = 'Callback reported success without a receipt number' WHERE id = $1`, [p.id]);
    return { handled: true };
  }
  const dup = await client.query(`SELECT id FROM payments WHERE mpesa_receipt = $1 AND id <> $2`, [receipt, p.id]);
  if (dup.rows[0]) {
    await client.query(`UPDATE payments SET status = 'held', hold_reason = $2 WHERE id = $1`, [p.id, `Duplicate M-Pesa receipt ${receipt} already recorded`]);
    await audit(client, SYSTEM_ACTOR, 'mpesa.duplicate_receipt', 'payment', p.id, { after: { receipt } });
    return { handled: true };
  }
  await client.query(`UPDATE payments SET mpesa_receipt = $2, occurred_at = COALESCE($3::timestamptz, now()) WHERE id = $1`, [p.id, receipt, occurredAt]);

  // The money amount reported by Safaricom must equal what we asked for.
  if (amount * 100 !== p.amount_cents) {
    await client.query(`UPDATE payments SET status = 'held', hold_reason = $2 WHERE id = $1`, [
      p.id, `Amount mismatch: requested KSh ${p.amount_cents / 100}, M-Pesa reported KSh ${amount}`,
    ]);
    await audit(client, SYSTEM_ACTOR, 'mpesa.amount_mismatch', 'payment', p.id, { after: { requested: p.amount_cents, reported: amount * 100 } });
    return { handled: true };
  }
  const outcome = await confirmPayment(client, p.id, SYSTEM_ACTOR);
  await announceOutcome(client, p.member_id, outcome);
  return { handled: true };
}

async function announceOutcome(client: Client, memberId: string | null, outcome: ApplyOutcome) {
  if (!memberId) return;
  if (outcome.outcome === 'confirmed' || outcome.outcome === 'fines_paid') {
    await notifyMember(client, memberId, 'payment_confirmed', 'Payment received', `Payment confirmed. Receipt ${outcome.receiptNo}.`, true);
  } else if (outcome.outcome === 'held') {
    await notifyMember(client, memberId, 'payment_held', 'Payment under review', `Your payment is being reviewed by the treasurer: ${outcome.reason}`);
  }
}

interface C2BBody {
  TransID?: string;
  TransAmount?: string | number;
  MSISDN?: string | number;
  BillRefNumber?: string;
  TransTime?: string;
  FirstName?: string;
}

/**
 * Paybill/Till payment made directly (not via STK). Account number = membership number
 * ("MBR-0007" for savings, "MBR-0007F" for fines). Anything we cannot match is kept as an unmatched payment.
 */
export async function processC2B(client: Client, body: C2BBody): Promise<{ handled: boolean }> {
  const receipt = String(body.TransID ?? '').toUpperCase();
  const amountCents = Math.round(Number(body.TransAmount ?? 0) * 100);
  if (!receipt || amountCents <= 0) return { handled: false };

  const dup = await client.query(`SELECT id FROM payments WHERE mpesa_receipt = $1`, [receipt]);
  if (dup.rows[0]) return { handled: true }; // already recorded: idempotent

  const ref = String(body.BillRefNumber ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const isFine = ref.endsWith('F');
  const membershipNo = isFine ? ref.slice(0, -1) : ref;
  const m = await client.query(`SELECT id FROM members WHERE membership_no = $1`, [membershipNo]);
  const t = String(body.TransTime ?? '');
  const occurredAt = /^\d{14}$/.test(t)
    ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}+03:00`
    : null;
  const ins = await client.query(
    `INSERT INTO payments (member_id, purpose, channel, amount_cents, phone, status, mpesa_receipt, occurred_at, raw_callback, hold_reason)
     VALUES ($1,$2,'c2b',$3,$4,'initiated',$5,COALESCE($6::timestamptz, now()),$7,$8)
     ON CONFLICT (mpesa_receipt) WHERE mpesa_receipt IS NOT NULL DO NOTHING RETURNING id`,
    [m.rows[0]?.id ?? null, isFine ? 'fine' : 'savings', amountCents, normalizePhone(String(body.MSISDN ?? '')), receipt, occurredAt, JSON.stringify(body), m.rows[0] ? null : `Account reference "${body.BillRefNumber ?? ''}" matched no member`],
  );
  if (!ins.rows[0]) return { handled: true };
  const outcome = await confirmPayment(client, ins.rows[0].id, SYSTEM_ACTOR);
  await announceOutcome(client, m.rows[0]?.id ?? null, outcome);
  return { handled: true };
}

/** After a status query shows a prompt failed, close it out; successes still arrive via the callback. */
export async function applyQueriedFailure(client: Client, paymentId: string, code: number, desc: string, actor: Actor) {
  await failPayment(client, paymentId, code === 1032 ? 'cancelled' : 'failed', code, desc, actor);
}

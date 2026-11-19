import { Router } from 'express';
import { z } from 'zod';
import { pool, withTx } from '../db/pool.js';
import { actorOf, authenticate, requireMember } from '../middleware/auth.js';
import { h, HttpError } from '../lib/http.js';
import { stkPush, stkQuery } from '../services/mpesa.js';
import { applyQueriedFailure, planMemberPayment, recordInitiatedStk } from '../services/payments.js';
import { cancelWithdrawal, requestWithdrawal, respondToClarification, submitApology, submitPaymentProof } from '../services/governance.js';
import { memberStatementDoc, toPdf, toXlsx } from '../services/reports.js';
import { todayEAT } from '../services/obligations.js';

/** Additional member self-service endpoints (payments, meetings, withdrawals, notifications, statements). */
export const memberPortalRouter = Router();
memberPortalRouter.use(authenticate, requireMember);

const planSchema = z.object({
  purpose: z.enum(['savings', 'fine']),
  months: z.number().int().min(1).max(36).optional(),
  fineIds: z.array(z.string().uuid()).optional(),
});

memberPortalRouter.post(
  '/pay/preview',
  h(async (req, res) => {
    const plan = await planMemberPayment(pool, req.user!.memberId!, planSchema.parse(req.body));
    const m = (await pool.query(`SELECT mpesa_phone FROM members WHERE id = $1`, [req.user!.memberId])).rows[0];
    res.json({ ...plan, mpesaPhone: m.mpesa_phone });
  }),
);

/** Sends an STK prompt to the member's registered M-Pesa number. This does not confirm any payment. */
memberPortalRouter.post(
  '/pay',
  h(async (req, res) => {
    const memberId = req.user!.memberId!;
    const body = planSchema.parse(req.body);
    const plan = await planMemberPayment(pool, memberId, body);
    if (plan.amountCents % 100 !== 0) throw new HttpError(400, 'Amount must be whole shillings for M-Pesa');
    const m = (await pool.query(`SELECT mpesa_phone, membership_no, status FROM members WHERE id = $1`, [memberId])).rows[0];
    if (!['active', 'suspended'].includes(m.status)) throw new HttpError(403, 'Your membership is not active');
    if (!m.mpesa_phone) throw new HttpError(409, 'No M-Pesa number is on file for you. Ask the secretary to add it.');
    // Stop double-taps: one open prompt per purpose at a time.
    const open = await pool.query(
      `SELECT 1 FROM payments WHERE member_id = $1 AND purpose = $2 AND status = 'initiated' AND channel = 'stk_push' AND created_at > now() - interval '3 minutes'`,
      [memberId, plan.purpose],
    );
    if (open.rows[0]) throw new HttpError(409, 'A payment prompt was just sent to your phone. Complete it, or wait 3 minutes to try again.');

    const stk = await stkPush({
      phone: m.mpesa_phone,
      amountKes: plan.amountCents / 100,
      accountRef: plan.purpose === 'fine' ? `${m.membership_no}F` : m.membership_no,
      description: plan.description,
    });
    const id = await withTx((c) =>
      recordInitiatedStk(c, { memberId, plan, phone: m.mpesa_phone, checkoutRequestId: stk.checkoutRequestId, merchantRequestId: stk.merchantRequestId, userId: req.user!.id }),
    );
    res.status(202).json({ paymentId: id, message: 'Check your phone and enter your M-Pesa PIN to complete the payment.' });
  }),
);

/** Poll a payment. If the callback is late, ask Safaricom; a failure is closed out, a success arrives by callback. */
memberPortalRouter.post(
  '/payments/:id/check',
  h(async (req, res) => {
    const p = (await pool.query(`SELECT * FROM payments WHERE id = $1 AND member_id = $2`, [req.params.id, req.user!.memberId])).rows[0];
    if (!p) throw new HttpError(404, 'Payment not found');
    if (p.status === 'initiated' && p.checkout_request_id && Date.now() - new Date(p.created_at).getTime() > 20_000) {
      try {
        const q = await stkQuery(p.checkout_request_id);
        if (q.resultCode !== 0) await withTx((c) => applyQueriedFailure(c, p.id, q.resultCode, q.resultDesc, actorOf(req)));
      } catch {
        /* still processing */
      }
    }
    const fresh = (await pool.query(`SELECT id, status, receipt_no, hold_reason, result_desc FROM payments WHERE id = $1`, [p.id])).rows[0];
    res.json(fresh);
  }),
);

// ---------------------------------------------------------------- manual M-Pesa message verification
const proofSchema = z.object({
  mpesaCode: z.string().min(8),
  amountCents: z.number().int().positive(),
  phone: z.string(),
  paidAt: z.string().datetime(),
  purpose: z.enum(['savings', 'fine']),
  fineIds: z.array(z.string().uuid()).optional(),
  messageText: z.string().max(2000).optional(),
  screenshotId: z.string().uuid().optional(),
});

memberPortalRouter.post(
  '/submissions',
  h(async (req, res) => {
    const body = proofSchema.parse(req.body);
    if (body.screenshotId) {
      const f = await pool.query(`SELECT 1 FROM stored_files WHERE id = $1 AND uploaded_by = $2`, [body.screenshotId, req.user!.id]);
      if (!f.rows[0]) throw new HttpError(400, 'Screenshot not found');
    }
    const id = await withTx((c) => submitPaymentProof(c, req.user!.memberId!, body, actorOf(req)));
    res.status(201).json({ id, message: 'Submitted. The treasurer will verify it against the official M-Pesa records.' });
  }),
);

memberPortalRouter.get(
  '/submissions',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, mpesa_code, amount_cents, purpose, status, review_note, created_at FROM payment_submissions WHERE member_id = $1 ORDER BY created_at DESC`,
      [req.user!.memberId],
    );
    res.json(rows);
  }),
);

memberPortalRouter.post(
  '/submissions/:id/reply',
  h(async (req, res) => {
    const { message } = z.object({ message: z.string().trim().min(2).max(1000) }).parse(req.body);
    await withTx((c) => respondToClarification(c, String(req.params.id), req.user!.memberId!, message, actorOf(req)));
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- meetings
memberPortalRouter.get(
  '/meetings',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT mt.id, mt.title, mt.scheduled_at, mt.venue, mt.agenda, mt.status, mt.minutes IS NOT NULL OR mt.minutes_file_id IS NOT NULL AS has_minutes,
              COALESCE(a.status::text, 'pending') AS my_status, a.apology_reason, COALESCE(a.apology_reviewed,false) AS apology_reviewed,
              (SELECT f.reference FROM fines f WHERE f.meeting_id = mt.id AND f.member_id = $1 AND f.category = 'absence' AND f.status <> 'reversed' LIMIT 1) AS fine_reference
         FROM meetings mt LEFT JOIN attendance a ON a.meeting_id = mt.id AND a.member_id = $1
        WHERE mt.status <> 'cancelled' ORDER BY mt.scheduled_at DESC`,
      [req.user!.memberId],
    );
    const attended = rows.filter((r) => r.status === 'register_confirmed');
    res.json({
      meetings: rows,
      totals: {
        scheduled: rows.filter((r) => r.status === 'scheduled').length,
        attended: attended.filter((r) => r.my_status === 'present').length,
        excused: attended.filter((r) => r.my_status === 'excused').length,
        unexcused: attended.filter((r) => r.my_status === 'absent').length,
      },
    });
  }),
);

memberPortalRouter.post(
  '/meetings/:id/apology',
  h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5).max(500) }).parse(req.body);
    await withTx((c) => submitApology(c, String(req.params.id), req.user!.memberId!, reason));
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- withdrawals
memberPortalRouter.get(
  '/withdrawals',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT w.id, w.reference, w.amount_cents, w.reason, w.status, w.current_level, w.required_levels, w.created_at, w.paid_at,
              COALESCE((SELECT json_agg(json_build_object('level', a.level, 'role', a.role, 'decision', a.decision, 'reason', a.reason, 'at', a.decided_at) ORDER BY a.level)
                          FROM withdrawal_approvals a WHERE a.withdrawal_id = w.id), '[]'::json) AS approvals
         FROM withdrawals w WHERE w.member_id = $1 ORDER BY w.created_at DESC`,
      [req.user!.memberId],
    );
    const bal = (await pool.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE member_id = $1`, [req.user!.memberId])).rows[0].b;
    res.json({ balanceCents: bal, withdrawals: rows });
  }),
);

memberPortalRouter.post(
  '/withdrawals',
  h(async (req, res) => {
    const b = z.object({ amountCents: z.number().int().positive(), reason: z.string().trim().min(5).max(500) }).parse(req.body);
    const r = await withTx((c) => requestWithdrawal(c, req.user!.memberId!, b.amountCents, b.reason, actorOf(req)));
    res.status(201).json(r);
  }),
);

memberPortalRouter.post(
  '/withdrawals/:id/cancel',
  h(async (req, res) => {
    await withTx((c) => cancelWithdrawal(c, String(req.params.id), req.user!.memberId!, actorOf(req)));
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------- notifications, documents, privacy, statement
memberPortalRouter.get(
  '/notifications',
  h(async (req, res) => {
    const { rows } = await pool.query(`SELECT id, kind, title, body, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.user!.id]);
    res.json(rows);
  }),
);

memberPortalRouter.post(
  '/notifications/read',
  h(async (req, res) => {
    await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [req.user!.id]);
    res.json({ ok: true });
  }),
);

memberPortalRouter.get(
  '/documents',
  h(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.category, d.file_id, d.created_at, d.description, d.document_date, d.version FROM documents d WHERE d.visibility = 'members' AND d.status = 'current' ORDER BY d.category, d.document_date DESC NULLS LAST`,
    );
    res.json(rows);
  }),
);

memberPortalRouter.get(
  '/profile',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT m.membership_no, m.full_name, m.phone, m.mpesa_phone, m.email, m.status, m.registered_on, m.photo_file_id, u.consent_version
         FROM members m JOIN users u ON u.member_id = m.id WHERE m.id = $1`,
      [req.user!.memberId],
    );
    res.json(rows[0]);
  }),
);

memberPortalRouter.get(
  '/statement',
  h(async (req, res) => {
    const format = String(req.query.format ?? 'pdf');
    const doc = await memberStatementDoc(pool, req.user!.memberId!, { from: req.query.from as string | undefined, to: req.query.to as string | undefined });
    const day = await todayEAT(pool);
    if (format === 'xlsx') {
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="statement-${day}.xlsx"` });
      res.send(await toXlsx(doc));
    } else {
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="statement-${day}.pdf"` });
      res.send(await toPdf(doc));
    }
  }),
);

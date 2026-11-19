import { Router } from 'express';
import { z } from 'zod';
import { pool, withTx } from '../db/pool.js';
import { actorOf, authenticate, requirePermission } from '../middleware/auth.js';
import { h, HttpError } from '../lib/http.js';
import { accrueLateFines, generateObligationsForMonth, todayEAT } from '../services/obligations.js';
import { confirmPayment, getMemberSummary, getReceipt, imposeFine, resolveFine, reversePayment } from '../services/ledger.js';

/** Officials' financial operations. Every route is permission-gated on the server. */
export const financeRouter = Router();
financeRouter.use(authenticate);

financeRouter.post(
  '/obligations/generate',
  requirePermission('obligations.generate'),
  h(async (req, res) => {
    const { period } = z.object({ period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/) }).parse(req.body);
    const p = period.length === 7 ? `${period}-01` : period;
    const result = await withTx(async (c) => {
      const asOf = await todayEAT(c);
      const created = await generateObligationsForMonth(c, p, asOf, actorOf(req));
      const { fines } = await accrueLateFines(c, asOf, actorOf(req));
      return { created, lateFinesAccrued: fines };
    });
    res.json(result);
  }),
);

financeRouter.post(
  '/fines/accrue',
  requirePermission('obligations.generate'),
  h(async (req, res) => {
    const result = await withTx(async (c) => accrueLateFines(c, await todayEAT(c), actorOf(req)));
    res.json(result);
  }),
);

const manualPaymentSchema = z.object({
  memberId: z.string().uuid(),
  purpose: z.enum(['savings', 'fine']),
  amountCents: z.number().int().positive(),
  mpesaReceipt: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{8,12}$/, 'Enter the M-Pesa transaction code'),
  paidAt: z.string().datetime().optional(),
  fineIds: z.array(z.string().uuid()).optional(),
});

/** Treasurer records a payment that has been verified against the official M-Pesa statement. */
financeRouter.post(
  '/payments/manual',
  requirePermission('payments.verify'),
  h(async (req, res) => {
    const b = manualPaymentSchema.parse(req.body);
    const actor = actorOf(req);
    const result = await withTx(async (c) => {
      const dup = await c.query(`SELECT id FROM payments WHERE mpesa_receipt = $1`, [b.mpesaReceipt]);
      if (dup.rows[0]) throw new HttpError(409, 'This M-Pesa transaction code has already been recorded', 'DUPLICATE_RECEIPT');
      const ins = await c.query(
        `INSERT INTO payments (member_id, purpose, channel, amount_cents, status, mpesa_receipt, fine_ids, occurred_at, created_by)
         VALUES ($1,$2,'manual',$3,'initiated',$4,$5,$6,$7) RETURNING id`,
        [b.memberId, b.purpose, b.amountCents, b.mpesaReceipt, b.fineIds ?? null, b.paidAt ?? null, actor.userId],
      );
      return confirmPayment(c, ins.rows[0].id, actor);
    });
    res.status(result.outcome === 'held' ? 202 : 201).json(result);
  }),
);

financeRouter.post(
  '/payments/:id/reverse',
  requirePermission('payments.reconcile'),
  h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5) }).parse(req.body);
    await withTx((c) => reversePayment(c, String(req.params.id), reason, actorOf(req)));
    res.json({ ok: true });
  }),
);

financeRouter.get(
  '/payments',
  requirePermission('payments.read_all'),
  h(async (req, res) => {
    const status = String(req.query.status ?? '');
    const { rows } = await pool.query(
      `SELECT p.id, p.receipt_no, p.purpose, p.channel, p.amount_cents, p.status, p.mpesa_receipt, p.hold_reason, p.created_at,
              m.full_name, m.membership_no
         FROM payments p LEFT JOIN members m ON m.id = p.member_id
        WHERE ($1 = '' OR p.status = $1::payment_status) ORDER BY p.created_at DESC LIMIT 500`,
      [status],
    );
    res.json(rows);
  }),
);

financeRouter.get(
  '/payments/:id/receipt',
  requirePermission('payments.read_all'),
  h(async (req, res) => res.json(await getReceipt(pool, String(req.params.id)))),
);

financeRouter.get(
  '/members/:id/summary',
  requirePermission('savings.read_all'),
  h(async (req, res) => res.json(await getMemberSummary(pool, String(req.params.id)))),
);

financeRouter.get(
  '/fines',
  requirePermission('fines.read_all'),
  h(async (req, res) => {
    const status = String(req.query.status ?? '');
    const { rows } = await pool.query(
      `SELECT f.*, m.full_name, m.membership_no FROM fines f JOIN members m ON m.id = f.member_id
        WHERE ($1 = '' OR f.status = $1::fine_status) ORDER BY f.created_at DESC LIMIT 500`,
      [status],
    );
    res.json(rows);
  }),
);

financeRouter.post(
  '/fines',
  requirePermission('fines.create'),
  h(async (req, res) => {
    const b = z
      .object({ memberId: z.string().uuid(), amountCents: z.number().int().positive(), reason: z.string().trim().min(3) })
      .parse(req.body);
    const id = await withTx((c) => imposeFine(c, { ...b, category: 'other' }, actorOf(req)));
    res.status(201).json({ id });
  }),
);

financeRouter.post(
  '/fines/:id/resolve',
  requirePermission('fines.waive'),
  h(async (req, res) => {
    const b = z.object({ kind: z.enum(['waiver', 'reversal']), reason: z.string().trim().min(5) }).parse(req.body);
    await withTx((c) => resolveFine(c, String(req.params.id), b.kind, b.reason, actorOf(req)));
    res.json({ ok: true });
  }),
);

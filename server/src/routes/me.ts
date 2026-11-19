import { Router } from 'express';
import { pool } from '../db/pool.js';
import { authenticate, requireMember } from '../middleware/auth.js';
import { h, HttpError } from '../lib/http.js';
import { getMemberSummary, getReceipt } from '../services/ledger.js';
import { getNok, submitNok } from '../services/nextOfKin.js';
import { docKind, getDocs, setDoc } from '../services/memberDocs.js';
import { storeFile, uploadSchema } from './files.js';
import { withTx } from '../db/pool.js';
import { actorOf } from '../middleware/auth.js';

/** Member self-service. Every query is scoped to req.user.memberId; members can never read others' data. */
export const meRouter = Router();
meRouter.use(authenticate, requireMember);

meRouter.get('/summary', h(async (req, res) => res.json(await getMemberSummary(pool, req.user!.memberId!))));

meRouter.get(
  '/obligations',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT o.id, o.period, o.amount_due_cents, o.due_date, o.status, o.paid_cents, o.paid_at, o.is_historical,
              f.reference AS fine_reference, f.amount_cents AS fine_cents, f.status AS fine_status, p.receipt_no
         FROM monthly_obligations o
         LEFT JOIN fines f ON f.obligation_id = o.id AND f.category = 'late_payment'
         LEFT JOIN payments p ON p.id = o.payment_id
        WHERE o.member_id = $1 ORDER BY o.period DESC`,
      [req.user!.memberId],
    );
    res.json(rows);
  }),
);

meRouter.get(
  '/savings-ledger',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, type, amount_cents, reference, reason, is_historical, occurred_at,
              SUM(amount_cents) OVER (ORDER BY occurred_at, created_at) AS balance_cents
         FROM savings_transactions WHERE member_id = $1 ORDER BY occurred_at DESC, created_at DESC`,
      [req.user!.memberId],
    );
    res.json(rows);
  }),
);

meRouter.get(
  '/fines',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, reference, category, amount_cents, imposed_on, reason, status, paid_at, resolution_note
         FROM fines WHERE member_id = $1 ORDER BY imposed_on DESC, created_at DESC`,
      [req.user!.memberId],
    );
    res.json(rows);
  }),
);

meRouter.get(
  '/fine-ledger',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT fl.id, f.reference, fl.entry_type, fl.amount_cents, fl.note, fl.created_at
         FROM fine_ledger fl JOIN fines f ON f.id = fl.fine_id WHERE fl.member_id = $1 ORDER BY fl.created_at DESC, fl.id DESC`,
      [req.user!.memberId],
    );
    res.json(rows);
  }),
);

meRouter.get(
  '/payments',
  h(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT id, receipt_no, purpose, channel, amount_cents, status, mpesa_receipt, hold_reason, created_at, confirmed_at
         FROM payments WHERE member_id = $1 ORDER BY created_at DESC`,
      [req.user!.memberId],
    );
    res.json(rows);
  }),
);

meRouter.get(
  '/payments/:id/receipt',
  h(async (req, res) => {
    const r = await getReceipt(pool, String(req.params.id));
    if (r.payment.member_id !== req.user!.memberId) throw new HttpError(404, 'Payment not found');
    res.json(r);
  }),
);

/** The Next of Kin form. Members fill it once; after submission it is read-only to them. */
meRouter.get('/next-of-kin', h(async (req, res) => { const n = await getNok(pool, req.user!.memberId!); res.json(n); }));
meRouter.post('/next-of-kin', h(async (req, res) => {
  await withTx((c) => submitNok(c, req.user!.memberId!, req.body, actorOf(req), 'member'));
  res.status(201).json(await getNok(pool, req.user!.memberId!));
}));

/** Photo and identity card images. A member can add each once; the administrator replaces them. */
meRouter.get('/documents', h(async (req, res) => res.json(await getDocs(pool, req.user!.memberId!))));
meRouter.post('/documents/:kind', h(async (req, res) => {
  const kind = docKind(req.params.kind); const memberId = req.user!.memberId!;
  const file = uploadSchema.parse(req.body);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimeType)) throw new HttpError(400, 'Please upload a photo (JPEG, PNG or WebP)');
  if ((await getDocs(pool, memberId))[kind]) throw new HttpError(409, 'This is already uploaded. Ask the administrator if it needs to be replaced.', 'DOC_LOCKED');
  const fileId = await storeFile(file, req.user!.id);
  await setDoc(pool, memberId, kind, fileId, actorOf(req), false);
  res.status(201).json(await getDocs(pool, memberId));
}));

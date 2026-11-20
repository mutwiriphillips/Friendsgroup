import { Router, type Request } from 'express';
import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { pool, withTx } from '../db/pool.js';
import { actorOf, authenticate, requirePermission } from '../middleware/auth.js';
import { h, HttpError } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import { can, type Permission } from '../lib/permissions.js';
import { storeFile, uploadSchema } from './files.js';
import {
  amendAttendance, cancelMeeting, confirmRegister, createMeeting, decideExpenditure, decideWithdrawal, payExpenditure, recordIncome,
  recordWithdrawalPayout, requestExpenditure, reverseIncome, reviewApology, reviewSubmission, setAttendance, voidExpenditure,
} from '../services/governance.js';
import {
  generateReconciliation, getPeriodReport, importStatement, manualMatch, memberSchedule, reopenReconciliation, reviewReconciliation,
  submitReconciliation, updateDiscrepancy, type StatementRow,
} from '../services/reconciliation.js';
import { commitImport, parseTable, previewImport, type ImportKind } from '../services/imports.js';
import { notifyMany } from '../services/notifications.js';
import { computeSummary } from '../services/reconciliation.js';
import { ruleAt, todayEAT } from '../services/obligations.js';
import { recordManualPayment } from '../services/manualPayments.js';
import { owedSummary, raiseInvoice } from '../services/invoices.js';
import { clearFines, correctContributionInvoice, correctFine, correctManualPayment, correctMeeting, reverseManualPayment } from '../services/corrections.js';
import { allocatePayment, creditHistory, planAllocation, undoAllocation } from '../services/manualPayments.js';
import { renderWorkbook } from '../services/sheetview.js';
import { commitSheet, editCell, getGrid, gridToXlsx, parseSheet, previewSheet } from '../services/sheet.js';

export const adminRouter = Router();
adminRouter.use(authenticate, (req, res, next) => {
  if (req.user!.role === 'member') {
    res.status(403).json({ error: 'Officials only' });
    return;
  }
  next();
});

const uuid = z.string().uuid();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const authed = (req: Request) => ({ ...actorOf(req), userId: req.user!.id, role: req.user!.role as string });
const idParam = (req: Request) => String(req.params.id);

// ================================================================ dashboard
adminRouter.get(
  '/dashboard',
  h(async (req, res) => {
    const role = req.user!.role;
    const today = await todayEAT(pool);
    const month = `${today.slice(0, 7)}-01`;
    const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
    const out: Record<string, unknown> = { today };
    out.members = await q(`SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*)::int AS total, count(*) FILTER (WHERE NOT profile_complete AND status='active')::int AS incomplete FROM members`);
    if (can(role, 'finance.read') || can(role, 'reports.read')) {
      const s = await computeSummary(pool, month);
      out.month = s;
      out.recon = (await q(`SELECT status, evidence_level FROM reconciliation_periods WHERE period = $1`, [month])) ?? { status: 'pending' };
      out.discrepancies = await q(`SELECT count(*) FILTER (WHERE status IN ('unresolved','investigating'))::int AS open, count(*) FILTER (WHERE status='unresolved')::int AS unresolved, count(*) FILTER (WHERE severity='material' AND status IN ('unresolved','investigating'))::int AS material FROM discrepancies`);
      out.trend = (
        await pool.query(
          `SELECT to_char(period,'YYYY-MM') AS month, SUM(amount_due_cents) AS expected, SUM(paid_cents) AS collected
             FROM monthly_obligations WHERE NOT is_historical AND period >= ($1::date - interval '5 months') GROUP BY period ORDER BY period`,
          [month],
        )
      ).rows;
    }
    if (can(role, 'payments.verify')) {
      out.queues = await q(
        `SELECT (SELECT count(*) FROM payment_submissions WHERE status IN ('pending','clarification'))::int AS submissions,
                (SELECT count(*) FROM payments WHERE status IN ('held','unmatched'))::int AS held_payments`,
      );
    }
    if (can(role, 'withdrawals.review') || can(role, 'withdrawals.approve')) {
      out.withdrawals = await q(`SELECT count(*) FILTER (WHERE status IN ('submitted','in_review'))::int AS to_review, count(*) FILTER (WHERE status='approved')::int AS to_pay FROM withdrawals`);
    }
    if (can(role, 'expenditure.approve') || can(role, 'finance.record')) {
      out.expenditure = await q(`SELECT count(*) FILTER (WHERE status='pending')::int AS pending, count(*) FILTER (WHERE status='approved')::int AS to_pay FROM expenditure`);
    }
    if (can(role, 'documents.read') || can(role, 'documents.manage')) {
      out.records = await q(`SELECT count(*) FILTER (WHERE status = 'current' AND expires_on IS NOT NULL AND expires_on < $1::date)::int AS expired,
                                    count(*) FILTER (WHERE status = 'current' AND expires_on IS NOT NULL AND expires_on >= $1::date AND expires_on <= $1::date + 60)::int AS expiring_soon,
                                    count(*) FILTER (WHERE status = 'current')::int AS current_total FROM documents`, [today]);
    }
    if (can(role, 'meetings.manage')) {
      out.nextMeeting = await q(`SELECT id, title, scheduled_at, venue FROM meetings WHERE status = 'scheduled' AND scheduled_at > now() ORDER BY scheduled_at LIMIT 1`);
    }
    res.json(out);
  }),
);

// ================================================================ rules & settings & financial years
adminRouter.get('/rules', requirePermission('settings.rules', 'finance.read', 'members.read'), h(async (_req, res) => {
  res.json((await pool.query(`SELECT * FROM rule_versions ORDER BY effective_from DESC`)).rows);
}));

adminRouter.post(
  '/rules',
  requirePermission('settings.rules'),
  h(async (req, res) => {
    const b = z.object({
      effectiveFrom: day, monthlyAmountCents: z.number().int().positive(), deadlineDay: z.number().int().min(1).max(28),
      lateFineCents: z.number().int().min(0), absenceFineCents: z.number().int().min(0), meetingsPerYear: z.number().int().min(0).max(12),
      reason: z.string().trim().min(5),
    }).parse(req.body);
    const today = await todayEAT(pool);
    if (b.effectiveFrom < `${today.slice(0, 7)}-01`) throw new HttpError(400, 'Rules cannot take effect before the current month; past obligations are never changed.');
    await withTx(async (c) => {
      const prev = (await c.query(`SELECT * FROM rule_versions ORDER BY effective_from DESC LIMIT 1`)).rows[0];
      await c.query(
        `INSERT INTO rule_versions (effective_from, monthly_amount_cents, deadline_day, late_fine_cents, absence_fine_cents, meetings_per_year, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [b.effectiveFrom, b.monthlyAmountCents, b.deadlineDay, b.lateFineCents, b.absenceFineCents, b.meetingsPerYear, b.reason, req.user!.id],
      );
      await audit(c, actorOf(req), 'rules.changed', 'rules', b.effectiveFrom, { reason: b.reason, before: prev, after: b });
    });
    res.status(201).json({ ok: true });
  }),
);

const SETTING_KEYS = ['group_name', 'withdrawal_approval_levels', 'withdrawal_min_cents', 'notification_reminder_days_before', 'auto_fines', 'admin_managed', 'hide_owed'] as const;
adminRouter.get('/settings', requirePermission('settings.rules', 'finance.read'), h(async (_req, res) => {
  res.json((await pool.query(`SELECT key, value FROM system_settings WHERE key = ANY($1)`, [SETTING_KEYS])).rows);
}));
adminRouter.put(
  '/settings/:key',
  requirePermission('settings.rules'),
  h(async (req, res) => {
    const key = String(req.params.key);
    if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new HttpError(400, 'Unknown setting');
    const schemas: Record<string, z.ZodTypeAny> = {
      group_name: z.string().trim().min(2).max(100),
      withdrawal_approval_levels: z.array(z.enum(['treasurer', 'chairperson', 'secretary', 'super_admin'])).min(1).max(3),
      withdrawal_min_cents: z.number().int().min(0),
      notification_reminder_days_before: z.number().int().min(0).max(14),
      admin_managed: z.object({ enabled: z.boolean() }),
      hide_owed: z.object({ enabled: z.boolean() }),
      auto_fines: z.object({ enabled: z.boolean(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).refine((v) => !v.enabled || v.from, 'Choose the date automatic fines start from'),
    };
    const { value, reason } = z.object({ value: schemas[key]!, reason: z.string().trim().min(3) }).parse(req.body);
    await withTx(async (c) => {
      const before = (await c.query(`SELECT value FROM system_settings WHERE key = $1`, [key])).rows[0]?.value;
      await c.query(`INSERT INTO system_settings (key, value, updated_by) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, JSON.stringify(value), req.user!.id]);
      await audit(c, actorOf(req), 'settings.changed', 'setting', key, { reason, before, after: value });
    });
    res.json({ ok: true });
  }),
);

adminRouter.get('/financial-years', h(async (_req, res) => res.json((await pool.query(`SELECT * FROM financial_years ORDER BY start_date DESC`)).rows)));
adminRouter.post(
  '/financial-years',
  requirePermission('settings.rules'),
  h(async (req, res) => {
    const b = z.object({ label: z.string().min(2).max(20), startDate: day, endDate: day, makeCurrent: z.boolean().default(false) }).parse(req.body);
    await withTx(async (c) => {
      if (b.makeCurrent) await c.query(`UPDATE financial_years SET is_current = false`);
      await c.query(`INSERT INTO financial_years (label, start_date, end_date, is_current) VALUES ($1,$2,$3,$4)`, [b.label, b.startDate, b.endDate, b.makeCurrent]);
      await audit(c, actorOf(req), 'financial_year.created', 'financial_year', b.label, { after: b });
    });
    res.status(201).json({ ok: true });
  }),
);

// ================================================================ staff users & audit
const genPassword = () => Array.from({ length: 14 }, () => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(54)]).join('');

adminRouter.get('/users', requirePermission('users.manage'), h(async (_req, res) => {
  res.json((await pool.query(`SELECT id, email, role, is_active, created_at, (SELECT max(at) FROM login_activity l WHERE l.user_id = users.id AND success) AS last_login FROM users WHERE role <> 'member' ORDER BY created_at`)).rows);
}));
adminRouter.post(
  '/users',
  requirePermission('users.manage'),
  h(async (req, res) => {
    const b = z.object({ email: z.string().email(), role: z.enum(['super_admin', 'chairperson', 'treasurer', 'secretary']) }).parse(req.body);
    const temp = genPassword();
    const { rows } = await pool.query(`INSERT INTO users (email, password_hash, role, must_change_password) VALUES ($1,$2,$3,true) RETURNING id`, [b.email.toLowerCase(), await bcrypt.hash(temp, 12), b.role]);
    await audit(pool, actorOf(req), 'user.created', 'user', rows[0].id, { after: b });
    res.status(201).json({ id: rows[0].id, temporaryPassword: temp });
  }),
);
adminRouter.post(
  '/users/:id/active',
  requirePermission('users.manage'),
  h(async (req, res) => {
    const { active, reason } = z.object({ active: z.boolean(), reason: z.string().trim().min(3) }).parse(req.body);
    if (idParam(req) === req.user!.id) throw new HttpError(400, 'You cannot deactivate your own account');
    await pool.query(`UPDATE users SET is_active = $2 WHERE id = $1 AND role <> 'member'`, [idParam(req), active]);
    await audit(pool, actorOf(req), active ? 'user.activated' : 'user.deactivated', 'user', idParam(req), { reason });
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/users/:id/reset-password',
  requirePermission('users.manage'),
  h(async (req, res) => {
    const temp = genPassword();
    const r = await pool.query(`UPDATE users SET password_hash = $2, must_change_password = true, failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING id`, [idParam(req), await bcrypt.hash(temp, 12)]);
    if (!r.rows[0]) throw new HttpError(404, 'User not found');
    await audit(pool, actorOf(req), 'user.password_reset', 'user', idParam(req));
    res.json({ temporaryPassword: temp });
  }),
);

adminRouter.get(
  '/audit',
  requirePermission('audit.read'),
  h(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 500);
    const offset = Number(req.query.offset ?? 0);
    const { rows } = await pool.query(
      `SELECT a.id, a.at, a.action, a.entity_type, a.entity_id, a.reason, a.user_role, u.email AS user_email, a.before, a.after
         FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
        WHERE ($1 = '' OR a.action ILIKE $1 || '%') AND ($2 = '' OR a.entity_type = $2) AND ($3 = '' OR a.entity_id = $3)
        ORDER BY a.id DESC LIMIT $4 OFFSET $5`,
      [String(req.query.action ?? ''), String(req.query.entity ?? ''), String(req.query.id ?? ''), limit, offset],
    );
    res.json(rows);
  }),
);

adminRouter.get(
  '/logins',
  requirePermission('audit.read'),
  h(async (_req, res) => res.json((await pool.query(`SELECT identifier, success, ip, user_agent, at FROM login_activity ORDER BY id DESC LIMIT 200`)).rows)),
);

// ================================================================ savings adjustment & member photo
adminRouter.post(
  '/savings/adjust',
  requirePermission('savings.adjust'),
  h(async (req, res) => {
    const b = z.object({ memberId: uuid, amountCents: z.number().int().refine((n) => n !== 0), reason: z.string().trim().min(10) }).parse(req.body);
    await withTx(async (c) => {
      const { lockMember } = await import('../services/ledger.js');
      await lockMember(c, b.memberId);
      const bal = Number((await c.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE member_id = $1`, [b.memberId])).rows[0].b);
      if (bal + b.amountCents < 0) throw new HttpError(409, 'The adjustment would make the savings balance negative');
      const t = await c.query(`INSERT INTO savings_transactions (member_id, type, amount_cents, reason, created_by) VALUES ($1,'adjustment',$2,$3,$4) RETURNING id`, [b.memberId, b.amountCents, b.reason, req.user!.id]);
      await audit(c, actorOf(req), 'savings.adjusted', 'savings_txn', t.rows[0].id, { reason: b.reason, after: b });
    });
    res.status(201).json({ ok: true });
  }),
);

adminRouter.post(
  '/members/:id/photo',
  requirePermission('members.write'),
  h(async (req, res) => {
    const file = uploadSchema.parse(req.body);
    if (!file.mimeType.startsWith('image/')) throw new HttpError(400, 'Profile photos must be images');
    const fileId = await storeFile(file, req.user!.id);
    await pool.query(`UPDATE members SET photo_file_id = $2, updated_at = now() WHERE id = $1`, [idParam(req), fileId]);
    await audit(pool, actorOf(req), 'member.photo_updated', 'member', idParam(req));
    res.json({ fileId });
  }),
);

// ================================================================ meetings
adminRouter.get('/meetings', requirePermission('meetings.manage', 'attendance.manage', 'reports.read'), h(async (_req, res) => {
  res.json((await pool.query(
    `SELECT mt.*, fy.label AS financial_year,
            (SELECT count(*) FROM attendance a WHERE a.meeting_id = mt.id AND a.status = 'present')::int AS present,
            (SELECT count(*) FROM attendance a WHERE a.meeting_id = mt.id AND a.status = 'absent')::int AS absent,
            (SELECT count(*) FROM attendance a WHERE a.meeting_id = mt.id AND a.status = 'excused')::int AS excused,
            (SELECT count(*) FROM attendance a WHERE a.meeting_id = mt.id AND a.status = 'pending')::int AS pending
       FROM meetings mt JOIN financial_years fy ON fy.id = mt.financial_year_id ORDER BY mt.scheduled_at DESC`)).rows);
}));

adminRouter.post(
  '/meetings',
  requirePermission('meetings.manage'),
  h(async (req, res) => {
    const b = z.object({ title: z.string().trim().min(3), scheduledAt: z.string().datetime({ offset: true }), venue: z.string().trim().min(2), agenda: z.string().optional() }).parse(req.body);
    const id = await withTx((c) => createMeeting(c, b, actorOf(req)));
    res.status(201).json({ id });
  }),
);

adminRouter.get(
  '/meetings/:id',
  requirePermission('meetings.manage', 'attendance.manage', 'reports.read'),
  h(async (req, res) => {
    const mt = (await pool.query(`SELECT * FROM meetings WHERE id = $1`, [idParam(req)])).rows[0];
    if (!mt) throw new HttpError(404, 'Meeting not found');
    const attendance = (await pool.query(
      `SELECT m.id AS member_id, m.membership_no, m.full_name, COALESCE(a.status::text,'pending') AS status, a.apology_reason, COALESCE(a.apology_reviewed,false) AS apology_reviewed,
              (SELECT f.reference FROM fines f WHERE f.meeting_id = $1 AND f.member_id = m.id AND f.category='absence' AND f.status <> 'reversed' LIMIT 1) AS fine_reference
         FROM members m LEFT JOIN attendance a ON a.meeting_id = $1 AND a.member_id = m.id
        WHERE m.status = 'active' OR a.member_id IS NOT NULL ORDER BY m.membership_no`, [idParam(req)])).rows;
    res.json({ meeting: mt, attendance });
  }),
);

adminRouter.post(
  '/meetings/:id/attendance',
  requirePermission('attendance.manage'),
  h(async (req, res) => {
    const b = z.object({ entries: z.array(z.object({ memberId: uuid, status: z.enum(['pending', 'present', 'absent', 'excused']) })).min(1).max(1000) }).parse(req.body);
    await withTx((c) => setAttendance(c, idParam(req), b.entries, actorOf(req)));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/meetings/:id/apology-review',
  requirePermission('attendance.manage'),
  h(async (req, res) => {
    const b = z.object({ memberId: uuid, approve: z.boolean() }).parse(req.body);
    await withTx((c) => reviewApology(c, idParam(req), b.memberId, b.approve, actorOf(req)));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/meetings/:id/confirm',
  requirePermission('attendance.manage'),
  h(async (req, res) => res.json(await withTx((c) => confirmRegister(c, idParam(req), actorOf(req))))),
);
adminRouter.post(
  '/meetings/:id/amend',
  requirePermission('attendance.manage'),
  h(async (req, res) => {
    const b = z.object({ memberId: uuid, status: z.enum(['present', 'absent', 'excused']), reason: z.string().trim().min(5) }).parse(req.body);
    // Reversing a fine is a financial decision: needs the same authority as waiving one.
    if (b.status !== 'absent' && !can(req.user!.role, 'fines.waive')) throw new HttpError(403, 'Reversing an absence fine requires the chairperson');
    await withTx((c) => amendAttendance(c, idParam(req), b.memberId, b.status, b.reason, actorOf(req)));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/meetings/:id/cancel',
  requirePermission('meetings.manage'),
  h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(3) }).parse(req.body);
    await withTx((c) => cancelMeeting(c, idParam(req), reason, actorOf(req)));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/meetings/:id/minutes',
  requirePermission('meetings.manage'),
  h(async (req, res) => {
    const b = z.object({ minutes: z.string().max(50000).optional(), file: uploadSchema.optional() }).parse(req.body);
    const fileId = b.file ? await storeFile(b.file, req.user!.id) : null;
    await pool.query(`UPDATE meetings SET minutes = COALESCE($2, minutes), minutes_file_id = COALESCE($3, minutes_file_id) WHERE id = $1`, [idParam(req), b.minutes ?? null, fileId]);
    if (fileId) {
      await pool.query(`INSERT INTO documents (title, category, file_id, visibility, uploaded_by, document_date) SELECT 'Minutes: ' || title, 'minutes', $2, 'members', $3, (scheduled_at AT TIME ZONE 'Africa/Nairobi')::date FROM meetings WHERE id = $1`, [idParam(req), fileId, req.user!.id]);
    }
    await audit(pool, actorOf(req), 'meeting.minutes_saved', 'meeting', idParam(req));
    res.json({ ok: true });
  }),
);

// ================================================================ withdrawals
adminRouter.get(
  '/withdrawals',
  requirePermission('withdrawals.review', 'withdrawals.approve', 'finance.read'),
  h(async (req, res) => {
    const status = String(req.query.status ?? '');
    res.json((await pool.query(
      `SELECT w.*, m.full_name, m.membership_no,
              COALESCE((SELECT SUM(amount_cents) FROM savings_transactions t WHERE t.member_id = w.member_id),0) AS current_balance_cents,
              COALESCE((SELECT SUM(amount_cents) FROM fine_ledger f WHERE f.member_id = w.member_id),0) AS fines_outstanding_cents,
              COALESCE((SELECT json_agg(json_build_object('level', a.level, 'role', a.role, 'decision', a.decision, 'reason', a.reason, 'at', a.decided_at) ORDER BY a.level) FROM withdrawal_approvals a WHERE a.withdrawal_id = w.id),'[]'::json) AS approvals
         FROM withdrawals w JOIN members m ON m.id = w.member_id WHERE ($1 = '' OR w.status = $1::withdrawal_status) ORDER BY w.created_at DESC LIMIT 300`,
      [status])).rows);
  }),
);
adminRouter.post(
  '/withdrawals/:id/decide',
  requirePermission('withdrawals.review', 'withdrawals.approve'),
  h(async (req, res) => {
    const b = z.object({ decision: z.enum(['approved', 'rejected']), reason: z.string().trim().optional() }).parse(req.body);
    const status = await withTx((c) => decideWithdrawal(c, idParam(req), b.decision, b.reason ?? null, authed(req)));
    res.json({ status });
  }),
);
adminRouter.post(
  '/withdrawals/:id/pay',
  requirePermission('finance.record'),
  h(async (req, res) => {
    const b = z.object({ payoutReference: z.string().trim().min(4).max(40) }).parse(req.body);
    await withTx((c) => recordWithdrawalPayout(c, idParam(req), b.payoutReference.toUpperCase(), actorOf(req)));
    res.json({ ok: true });
  }),
);

// ================================================================ income & expenditure
adminRouter.get('/income', requirePermission('finance.read'), h(async (_req, res) => {
  res.json((await pool.query(`SELECT * FROM income ORDER BY received_on DESC, created_at DESC LIMIT 300`)).rows);
}));
adminRouter.post(
  '/income',
  requirePermission('finance.record'),
  h(async (req, res) => {
    const b = z.object({
      category: z.enum(['special_contribution', 'other_income', 'opening_balance']), amountCents: z.number().int().positive(), receivedOn: day,
      description: z.string().trim().min(3), source: z.string().optional(), reference: z.string().optional(),
    }).parse(req.body);
    res.status(201).json({ id: await withTx((c) => recordIncome(c, b, actorOf(req))) });
  }),
);
adminRouter.post(
  '/income/:id/reverse',
  requirePermission('finance.record'),
  h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5) }).parse(req.body);
    await withTx((c) => reverseIncome(c, idParam(req), reason, actorOf(req)));
    res.json({ ok: true });
  }),
);

adminRouter.get('/expenditure', requirePermission('finance.read'), h(async (req, res) => {
  const status = String(req.query.status ?? '');
  res.json((await pool.query(
    `SELECT e.*, ru.email AS requested_by_email, au.email AS approved_by_email FROM expenditure e
       JOIN users ru ON ru.id = e.requested_by LEFT JOIN users au ON au.id = e.approved_by
      WHERE ($1 = '' OR e.status = $1::expenditure_status) ORDER BY e.created_at DESC LIMIT 300`, [status])).rows);
}));
adminRouter.post(
  '/expenditure',
  requirePermission('finance.record'),
  h(async (req, res) => {
    const b = z.object({
      category: z.enum(['administrative', 'meeting', 'other']), amountCents: z.number().int().positive(), spentOn: day, description: z.string().trim().min(3),
      recipient: z.string().trim().min(2), meetingId: uuid.optional(), file: uploadSchema.optional(),
    }).parse(req.body);
    const supportingFileId = b.file ? await storeFile(b.file, req.user!.id) : undefined;
    res.status(201).json(await withTx((c) => requestExpenditure(c, { ...b, supportingFileId }, authed(req))));
  }),
);
adminRouter.post(
  '/expenditure/:id/attach',
  requirePermission('finance.record'),
  h(async (req, res) => {
    const fileId = await storeFile(uploadSchema.parse(req.body), req.user!.id);
    const r = await pool.query(`UPDATE expenditure SET supporting_file_id = $2 WHERE id = $1 AND status IN ('pending','approved') RETURNING id`, [idParam(req), fileId]);
    if (!r.rows[0]) throw new HttpError(409, 'Documents can only be attached before payment');
    await audit(pool, actorOf(req), 'expenditure.document_attached', 'expenditure', idParam(req));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/expenditure/:id/decide',
  requirePermission('expenditure.approve'),
  h(async (req, res) => {
    const b = z.object({ approve: z.boolean(), note: z.string().trim().optional() }).parse(req.body);
    await withTx((c) => decideExpenditure(c, idParam(req), b.approve, b.note ?? null, authed(req)));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/expenditure/:id/pay',
  requirePermission('finance.record'),
  h(async (req, res) => {
    const b = z.object({ paymentReference: z.string().trim().min(3) }).parse(req.body);
    await withTx((c) => payExpenditure(c, idParam(req), b.paymentReference, actorOf(req)));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/expenditure/:id/void',
  requirePermission('expenditure.approve'),
  h(async (req, res) => {
    const b = z.object({ reason: z.string().trim().min(5) }).parse(req.body);
    await withTx((c) => voidExpenditure(c, idParam(req), b.reason, actorOf(req)));
    res.json({ ok: true });
  }),
);

// ================================================================ verification queue
adminRouter.get(
  '/submissions',
  requirePermission('payments.verify'),
  h(async (req, res) => {
    const status = String(req.query.status ?? '');
    const q = String(req.query.q ?? '').trim().toUpperCase();
    res.json((await pool.query(
      `SELECT s.*, m.full_name, m.membership_no,
              EXISTS (SELECT 1 FROM payments p WHERE p.mpesa_receipt = s.mpesa_code) AS already_recorded,
              COALESCE((SELECT json_agg(json_build_object('event', e.event, 'note', e.note, 'at', e.at) ORDER BY e.id) FROM submission_events e WHERE e.submission_id = s.id), '[]'::json) AS history
         FROM payment_submissions s JOIN members m ON m.id = s.member_id
        WHERE ($1 = '' OR s.status = $1::submission_status) AND ($2 = '' OR s.mpesa_code ILIKE '%' || $2 || '%')
        ORDER BY s.created_at DESC LIMIT 300`, [status, q])).rows);
  }),
);
adminRouter.post(
  '/submissions/:id/review',
  requirePermission('payments.verify'),
  h(async (req, res) => {
    const b = z.object({ action: z.enum(['approve', 'reject', 'clarify']), note: z.string().trim().optional(), verifiedAgainstOfficialRecords: z.boolean().default(false) }).parse(req.body);
    res.json({ outcome: await withTx((c) => reviewSubmission(c, idParam(req), b.action, b.note ?? null, b.verifiedAgainstOfficialRecords, actorOf(req))) });
  }),
);

// ================================================================ reconciliation
adminRouter.get('/reconciliation', requirePermission('reconciliation.work', 'reconciliation.approve', 'finance.read'), h(async (_req, res) => {
  res.json((await pool.query(`SELECT to_char(period,'YYYY-MM') AS month, status, evidence_level, is_historical, submitted_at, approved_at, review_note FROM reconciliation_periods ORDER BY period DESC`)).rows);
}));

adminRouter.post(
  '/reconciliation/generate',
  requirePermission('reconciliation.work'),
  h(async (req, res) => {
    const b = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), historical: z.boolean().default(false) }).parse(req.body);
    res.json(await withTx((c) => generateReconciliation(c, `${b.month}-01`, { historical: b.historical }, actorOf(req))));
  }),
);

adminRouter.get(
  '/reconciliation/:month',
  requirePermission('reconciliation.work', 'reconciliation.approve', 'finance.read'),
  h(async (req, res) => {
    const month = `${String(req.params.month)}-01`;
    const { row, summary, frozen } = await getPeriodReport(pool, month);
    res.json({ period: row, summary, frozen, schedule: await memberSchedule(pool, month) });
  }),
);

adminRouter.get(
  '/discrepancies',
  requirePermission('reconciliation.work', 'reconciliation.approve', 'finance.read'),
  h(async (req, res) => {
    const status = String(req.query.status ?? 'open');
    res.json((await pool.query(
      `SELECT d.*, u.email AS resolved_by_email FROM discrepancies d LEFT JOIN users u ON u.id = d.resolved_by
        WHERE ($1 = 'all') OR ($1 = 'open' AND d.status IN ('unresolved','investigating')) OR d.status::text = $1
        ORDER BY (d.severity = 'material') DESC, d.detected_at DESC LIMIT 500`, [status])).rows);
  }),
);
adminRouter.post(
  '/discrepancies/:id',
  requirePermission('reconciliation.work'),
  h(async (req, res) => {
    const b = z.object({ status: z.enum(['investigating', 'resolved', 'exception']), note: z.string().trim().min(3) }).parse(req.body);
    await withTx((c) => updateDiscrepancy(c, Number(idParam(req)), b.status, b.note, actorOf(req), can(req.user!.role, 'reconciliation.approve')));
    res.json({ ok: true });
  }),
);

adminRouter.post('/reconciliation/:month/submit', requirePermission('reconciliation.work'), h(async (req, res) => {
  await withTx((c) => submitReconciliation(c, `${String(req.params.month)}-01`, actorOf(req)));
  res.json({ ok: true });
}));
adminRouter.post(
  '/reconciliation/:month/review',
  requirePermission('reconciliation.approve'),
  h(async (req, res) => {
    const b = z.object({ approve: z.boolean(), note: z.string().trim().optional() }).parse(req.body);
    await withTx((c) => reviewReconciliation(c, `${String(req.params.month)}-01`, b.approve, b.note ?? null, authed(req)));
    res.json({ ok: true });
  }),
);
adminRouter.post(
  '/reconciliation/:month/reopen',
  requirePermission('reconciliation.reopen'),
  h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(10) }).parse(req.body);
    await withTx((c) => reopenReconciliation(c, `${String(req.params.month)}-01`, reason, actorOf(req)));
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/reconciliation/statement-import',
  requirePermission('payments.reconcile'),
  h(async (req, res) => {
    const f = z.object({ filename: z.string(), dataBase64: z.string().min(10) }).parse(req.body);
    const table = await parseTable(Buffer.from(f.dataBase64, 'base64'), f.filename);
    const pick = (r: Record<string, string>, names: string[]) => names.map((n) => r[n]).find((v) => v) ?? '';
    const rows: StatementRow[] = [];
    for (const r of table) {
      // Safaricom statements: "Receipt No.", "Completion Time", "Paid In", "Details", "Withdrawn".
      const receipt = pick(r, ['receipt_no.', 'receipt_no', 'receipt', 'transaction_id', 'trans_id', 'reference']);
      const paidIn = Number(pick(r, ['paid_in', 'amount', 'credit']).replace(/[,\s]/g, ''));
      if (!receipt || !Number.isFinite(paidIn) || paidIn <= 0) continue; // incoming money only
      const time = pick(r, ['completion_time', 'transaction_date', 'date', 'time']);
      rows.push({
        receipt, amountCents: Math.round(paidIn * 100), time: time && !Number.isNaN(Date.parse(time)) ? new Date(time.includes('T') || /Z|[+-]\d\d:?\d\d$/.test(time) ? time : `${time.replace(' ', 'T')}+03:00`).toISOString() : null,
        phone: pick(r, ['phone', 'msisdn', 'sender']) || null, type: pick(r, ['transaction_type', 'type', 'details']) || null,
      });
    }
    res.status(201).json(await withTx((c) => importStatement(c, f.filename, rows, actorOf(req))));
  }),
);
adminRouter.get(
  '/reconciliation-lines/list',
  requirePermission('payments.reconcile', 'reconciliation.work'),
  h(async (req, res) => {
    const status = String(req.query.status ?? 'unmatched');
    res.json((await pool.query(`SELECT * FROM statement_lines WHERE ($1 = 'all' OR match_status = $1) ORDER BY id DESC LIMIT 500`, [status])).rows);
  }),
);
adminRouter.post(
  '/reconciliation-lines/:id/match',
  requirePermission('payments.reconcile'),
  h(async (req, res) => {
    const b = z.object({ memberId: uuid, purpose: z.enum(['savings', 'fine']), fineIds: z.array(uuid).optional(), reason: z.string().trim().min(5) }).parse(req.body);
    res.json({ outcome: await withTx((c) => manualMatch(c, Number(idParam(req)), b, b.reason, actorOf(req))) });
  }),
);

// ================================================================ announcements & documents
adminRouter.get('/announcements', requirePermission('announcements.manage'), h(async (_req, res) => {
  res.json((await pool.query(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100`)).rows);
}));
adminRouter.post(
  '/announcements',
  requirePermission('announcements.manage'),
  h(async (req, res) => {
    const b = z.object({ title: z.string().trim().min(3), body: z.string().trim().min(3).max(1000), memberIds: z.array(uuid).optional(), sms: z.boolean().default(false) }).parse(req.body);
    const sent = await withTx(async (c) => {
      const a = await c.query(`INSERT INTO announcements (title, body, audience, member_ids, channels, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b.title, b.body, b.memberIds?.length ? 'selected' : 'all', b.memberIds ?? null, b.sms ? ['in_app', 'sms'] : ['in_app'], req.user!.id]);
      const n = await notifyMany(c, b.memberIds?.length ? b.memberIds : null, 'announcement', b.title, b.body, b.sms, `announcement:${a.rows[0].id}`);
      await audit(c, actorOf(req), 'announcement.sent', 'announcement', a.rows[0].id, { after: { recipients: n, sms: b.sms } });
      return n;
    });
    res.status(201).json({ recipients: sent });
  }),
);

// ---- Records register: certificate of registration, constitution, minutes, resolutions, returns, permits, etc.
const DOC_CATEGORIES = ['certificate_of_registration', 'constitution', 'minutes', 'resolution', 'financial_statement', 'policy', 'compliance', 'legal', 'correspondence', 'membership', 'group_sheet', 'other'] as const;

adminRouter.get(
  '/documents',
  requirePermission('documents.manage', 'documents.read'),
  h(async (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const { rows } = await pool.query(
      `SELECT d.id, d.title, d.category, d.visibility, d.file_id, d.created_at, d.description, d.reference_no, d.document_date, d.expires_on, d.version, d.status,
              d.supersedes_id, d.archived_reason, u.email AS uploaded_by_email, f.name AS file_name, f.mime_type, f.size_bytes
         FROM documents d JOIN stored_files f ON f.id = d.file_id LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE ($1::text IS NULL OR d.category = $1) AND ($2::text IS NULL OR d.status = $2)
          AND ($3::text IS NULL OR d.title ILIKE '%' || $3 || '%' OR d.reference_no ILIKE '%' || $3 || '%' OR d.description ILIKE '%' || $3 || '%')
        ORDER BY d.category, d.document_date DESC NULLS LAST, d.created_at DESC`,
      [q.category || null, q.status || null, q.q || null],
    );
    res.json(rows);
  }),
);

adminRouter.post(
  '/documents',
  requirePermission('documents.manage'),
  h(async (req, res) => {
    const b = z.object({
      title: z.string().trim().min(3).max(200), category: z.enum(DOC_CATEGORIES), visibility: z.enum(['members', 'officials']).default('members'),
      description: z.string().trim().max(1000).optional(), referenceNo: z.string().trim().max(100).optional(),
      documentDate: day.optional(), expiresOn: day.optional(), supersedesId: uuid.optional(), file: uploadSchema,
    }).parse(req.body);
    const fileId = await storeFile(b.file, req.user!.id);
    const id = await withTx(async (c) => {
      let version = 1;
      if (b.supersedesId) {
        const old = (await c.query(`SELECT id, version, status FROM documents WHERE id = $1 FOR UPDATE`, [b.supersedesId])).rows[0];
        if (!old) throw new HttpError(404, 'The document being replaced was not found');
        if (old.status !== 'current') throw new HttpError(409, 'Only the current version can be replaced');
        version = old.version + 1;
        await c.query(`UPDATE documents SET status = 'superseded' WHERE id = $1`, [b.supersedesId]);
      }
      const { rows } = await c.query(
        `INSERT INTO documents (title, category, file_id, visibility, uploaded_by, description, reference_no, document_date, expires_on, version, supersedes_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, (now() AT TIME ZONE 'Africa/Nairobi')::date),$9,$10,$11) RETURNING id`,
        [b.title, b.category, fileId, b.visibility, req.user!.id, b.description ?? null, b.referenceNo ?? null, b.documentDate ?? null, b.expiresOn ?? null, version, b.supersedesId ?? null],
      );
      await audit(c, actorOf(req), b.supersedesId ? 'document.new_version' : 'document.uploaded', 'document', rows[0].id, { after: { title: b.title, category: b.category, visibility: b.visibility, version, supersedes: b.supersedesId } });
      return rows[0].id as string;
    });
    res.status(201).json({ id });
  }),
);

adminRouter.post(
  '/documents/:id/archive',
  requirePermission('documents.manage'),
  h(async (req, res) => {
    const { reason } = z.object({ reason: z.string().trim().min(5) }).parse(req.body);
    const r = await pool.query(`UPDATE documents SET status = 'archived', archived_reason = $2 WHERE id = $1 AND status <> 'archived' RETURNING id`, [idParam(req), reason]);
    if (!r.rows[0]) throw new HttpError(404, 'Document not found or already archived');
    await audit(pool, actorOf(req), 'document.archived', 'document', idParam(req), { reason });
    res.json({ ok: true });
  }),
);

// ================================================================ historical data import
const KIND_PERMISSION: Record<ImportKind, Permission> = {
  members: 'members.write', previous_attendance: 'attendance.manage', historical_savings: 'finance.record', previous_fines: 'finance.record', opening_balances: 'finance.record',
};
function kindOf(req: Request): ImportKind {
  const k = String(req.params.kind) as ImportKind;
  if (!(k in KIND_PERMISSION)) throw new HttpError(404, 'Unknown import type');
  if (!can(req.user!.role, KIND_PERMISSION[k])) throw new HttpError(403, 'You do not have permission to import this data');
  return k;
}
const importBody = z.object({ filename: z.string(), dataBase64: z.string().min(10), strict: z.boolean().optional() });

adminRouter.post(
  '/imports/:kind/preview',
  h(async (req, res) => {
    const kind = kindOf(req);
    const f = importBody.parse(req.body);
    const table = await parseTable(Buffer.from(f.dataBase64, 'base64'), f.filename);
    const client = await pool.connect();
    let rows;
    try {
      rows = await previewImport(client, kind, table, { strict: f.strict });
    } finally {
      client.release();
    }
    res.json({ total: rows.length, valid: rows.filter((r) => !r.errors.length).length, invalid: rows.filter((r) => r.errors.length).length, rows: rows.slice(0, 500) });
  }),
);
adminRouter.post(
  '/imports/:kind/commit',
  h(async (req, res) => {
    const kind = kindOf(req);
    const f = importBody.parse(req.body);
    const table = await parseTable(Buffer.from(f.dataBase64, 'base64'), f.filename);
    res.status(201).json(await withTx((c) => commitImport(c, kind, table, f.filename, actorOf(req), { strict: f.strict })));
  }),
);

// ================================================================ member ledger grid (the group's sheet)
adminRouter.get('/ledger-grid', requirePermission('ledger.read'), h(async (req, res) => {
  const g = await getGrid(pool);
  res.json({ ...g, canEdit: can(req.user!.role, 'ledger.edit') });
}));

adminRouter.get('/ledger-grid/export', requirePermission('ledger.read'), h(async (req, res) => {
  const body = await gridToXlsx(pool);
  await audit(pool, actorOf(req), 'report.generated', 'report', 'ledger_grid', { after: { format: 'xlsx' } });
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="member-ledger-${new Date().toISOString().slice(0, 10)}.xlsx"` });
  res.send(body);
}));

const sheetBody = z.object({ filename: z.string().min(1).max(200), dataBase64: z.string().min(10) });
adminRouter.post('/ledger-grid/import/preview', requirePermission('ledger.edit'), h(async (req, res) => {
  const f = sheetBody.parse(req.body);
  const parsed = await parseSheet(Buffer.from(f.dataBase64, 'base64'));
  res.json(await previewSheet(pool, parsed));
}));
adminRouter.post('/ledger-grid/import/commit', requirePermission('ledger.edit'), h(async (req, res) => {
  const f = sheetBody.parse(req.body);
  const parsed = await parseSheet(Buffer.from(f.dataBase64, 'base64'));
  res.status(201).json(await withTx((c) => commitSheet(c, parsed, f.filename, actorOf(req))));
}));

const cellBody = z.object({
  memberId: uuid, kind: z.enum(['cont', 'fine', 'meeting']),
  period: z.string().regex(/^\d{4}-\d{2}-01$/).optional(), meetingId: uuid.optional(),
  value: z.number().finite().min(-1_000_000).max(1_000_000), reason: z.string().min(3).max(500),
});
adminRouter.post('/ledger-grid/cell', requirePermission('ledger.edit'), h(async (req, res) => {
  const b = cellBody.parse(req.body);
  res.json(await withTx((c) => editCell(c, b, actorOf(req))));
}));

// ================================================================ the group's Excel sheet, kept and shown as it is
adminRouter.get('/group-sheet', requirePermission('documents.read', 'documents.manage'), h(async (req, res) => {
  const id = typeof req.query.id === 'string' ? req.query.id : null;
  const versions = (await pool.query(
    `SELECT d.id, d.title, d.version, d.status, d.document_date, d.created_at, d.file_id, f.name AS file_name, f.size_bytes
       FROM documents d JOIN stored_files f ON f.id = d.file_id WHERE d.category = 'group_sheet' ORDER BY d.version DESC, d.created_at DESC`)).rows;
  const doc = id ? versions.find((v) => v.id === id) : versions.find((v) => v.status === 'current') ?? versions[0];
  if (!doc) { res.json({ document: null, versions: [], sheets: [] }); return; }
  const file = (await pool.query(`SELECT data FROM stored_files WHERE id = $1`, [doc.file_id])).rows[0];
  res.json({ document: doc, versions, sheets: await renderWorkbook(file.data) });
}));

// ================================================================ invoices and manual payment entry (administrator only)
const payBody = z.object({
  memberId: uuid, amountKsh: z.number().finite().positive().max(10_000_000),
  message: z.string().min(10).max(2000), mpesaCode: z.string().max(20).optional(), paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
// Posting money does not pay any invoice by itself. The administrator then approves which invoices a received payment settles.
const allocBody = z.object({
  memberId: uuid, manualPaymentId: uuid, contributionIds: z.array(uuid).max(200).default([]), fineIds: z.array(uuid).max(200).default([]),
  advanceMonths: z.number().int().min(0).max(36).default(0), note: z.string().max(300).optional(),
});
adminRouter.get('/members/:id/credit', requirePermission('members.read'), h(async (req, res) => { res.json(await creditHistory(pool, idParam(req))); }));
adminRouter.post('/allocations/preview', requirePermission('payments.manual_entry'), h(async (req, res) => { res.json(await planAllocation(pool, allocBody.parse(req.body))); }));
adminRouter.post('/allocations', requirePermission('payments.manual_entry'), h(async (req, res) => {
  res.status(201).json(await withTx((c) => allocatePayment(c, allocBody.parse(req.body), actorOf(req))));
}));
adminRouter.post('/allocations/:id/undo', requirePermission('records.correct'), h(async (req, res) => {
  const b = z.object({ note: z.string().max(300) }).parse(req.body);
  res.json(await withTx((c) => undoAllocation(c, Number(req.params.id), b, actorOf(req))));
}));
adminRouter.post('/manual-payments', requirePermission('payments.manual_entry'), h(async (req, res) => {
  res.status(201).json(await withTx((c) => recordManualPayment(c, payBody.parse(req.body), actorOf(req))));
}));
adminRouter.get('/manual-payments', requirePermission('payments.manual_entry', 'payments.read_all'), h(async (req, res) => {
  const memberId = typeof req.query.memberId === 'string' ? req.query.memberId : null;
  res.json((await pool.query(
    `SELECT mp.id, mp.member_id, m.full_name, m.membership_no, mp.amount_cents, mp.period::text AS period, mp.paid_on::text AS paid_on, mp.kind, mp.allocation, mp.transaction_message, mp.mpesa_code, mp.created_at, mp.reversed_at, u.email AS recorded_by
       FROM manual_payments mp JOIN members m ON m.id = mp.member_id LEFT JOIN users u ON u.id = mp.recorded_by
      WHERE ($1::uuid IS NULL OR mp.member_id = $1) ORDER BY mp.created_at DESC LIMIT 200`, [memberId])).rows);
}));

adminRouter.get('/members/:id/invoices', requirePermission('members.read'), h(async (req, res) => {
  res.json(await owedSummary(pool, idParam(req)));
}));
adminRouter.get('/invoice-options', requirePermission('invoices.raise'), h(async (_req, res) => {
  const today = await todayEAT(pool);
  const rule = await ruleAt(pool, today);
  const meetings = (await pool.query(`SELECT id, title, (scheduled_at AT TIME ZONE 'Africa/Nairobi')::date::text AS date FROM meetings WHERE status <> 'cancelled' ORDER BY scheduled_at DESC LIMIT 100`)).rows;
  res.json({ today, monthlyCents: Number(rule.monthly_amount_cents), lateFineCents: Number(rule.late_fine_cents), absenceFineCents: Number(rule.absence_fine_cents), meetings });
}));
adminRouter.post('/invoices', requirePermission('invoices.raise'), h(async (req, res) => {
  const b = z.object({
    memberId: uuid.optional(), allMembers: z.boolean().optional(), kind: z.enum(['contribution', 'late_fine', 'meeting_fine']),
    period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), meetingId: uuid.optional(), amountKsh: z.number().finite().positive().max(1_000_000).optional(),
    lateFineApplies: z.boolean().optional(), note: z.string().max(200).optional(),
  }).parse(req.body);
  res.status(201).json(await withTx((c) => raiseInvoice(c, b, actorOf(req))));
}));

// ================================================================ corrections (administrator only; every change is audited with its reason)
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
adminRouter.patch('/fines/:id/correct', requirePermission('records.correct'), h(async (req, res) => {
  const b = z.object({ imposedOn: ymd.optional(), period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), reason: z.string().max(300).optional(), amountKsh: z.number().finite().positive().max(1_000_000).optional(), note: z.string().max(300) }).parse(req.body);
  res.json(await withTx((c) => correctFine(c, idParam(req), b, actorOf(req))));
}));
adminRouter.patch('/obligations/:id/correct', requirePermission('records.correct'), h(async (req, res) => {
  const b = z.object({ dueDate: ymd.optional(), period: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(), amountKsh: z.number().finite().positive().max(1_000_000).optional(), note: z.string().max(300) }).parse(req.body);
  res.json(await withTx((c) => correctContributionInvoice(c, idParam(req), b, actorOf(req))));
}));
adminRouter.patch('/meetings/:id/correct', requirePermission('records.correct'), h(async (req, res) => {
  const b = z.object({ title: z.string().max(200).optional(), scheduledAt: z.string().max(40).optional(), venue: z.string().max(200).optional(), agenda: z.string().max(2000).optional(), note: z.string().max(300) }).parse(req.body);
  res.json(await withTx((c) => correctMeeting(c, idParam(req), b, actorOf(req))));
}));
adminRouter.post('/fines/clear', requirePermission('records.correct'), h(async (req, res) => {
  const b = z.object({ memberId: uuid.optional(), note: z.string().max(300) }).parse(req.body);
  res.json(await withTx((c) => clearFines(c, b, actorOf(req))));
}));
adminRouter.post('/manual-payments/:id/reverse', requirePermission('records.correct'), h(async (req, res) => {
  const b = z.object({ note: z.string().max(300) }).parse(req.body);
  res.json(await withTx((c) => reverseManualPayment(c, idParam(req), b, actorOf(req))));
}));
adminRouter.patch('/manual-payments/:id/correct', requirePermission('records.correct'), h(async (req, res) => {
  const b = z.object({ paidOn: ymd.optional(), message: z.string().max(2000).optional(), note: z.string().max(300) }).parse(req.body);
  res.json(await withTx((c) => correctManualPayment(c, idParam(req), b, actorOf(req))));
}));

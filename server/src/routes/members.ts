import { Router } from 'express';
import { docKind, getDocs, setDoc } from '../services/memberDocs.js';
import { storeFile, uploadSchema } from './files.js';
import { amendNok, getNok, nokPdf, submitNok } from '../services/nextOfKin.js';
import { z } from 'zod';
import { pool, withTx } from '../db/pool.js';
import { actorOf, authenticate, requirePermission } from '../middleware/auth.js';
import { h, HttpError } from '../lib/http.js';
import { decryptField } from '../lib/crypto.js';
import { audit } from '../lib/audit.js';
import { normalizePhone } from '../lib/phone.js';
import { completeMemberProfile, completeProfileSchema, registerMember, registerMemberLenient, registerMemberSchema, setMemberStatus } from '../services/members.js';
import { getMemberSummary } from '../services/ledger.js';
import { memberOverview } from '../services/memberOverview.js';

export const membersRouter = Router();
membersRouter.use(authenticate);

const PUBLIC_COLUMNS = `id, membership_no, full_name, phone, mpesa_phone, email, physical_address, status, registered_on, photo_path, profile_complete, national_id_enc IS NULL AS missing_national_id, phone IS NULL AS missing_phone, nok_submitted_at IS NULL AS missing_nok, photo_file_id, id_front_file_id, id_back_file_id`;

membersRouter.get(
  '/',
  requirePermission('members.read'),
  h(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const status = String(req.query.status ?? '');
    const incomplete = req.query.incomplete === '1';
    const { rows } = await pool.query(
      `SELECT ${PUBLIC_COLUMNS},
              COALESCE((SELECT SUM(amount_cents) FROM savings_transactions s WHERE s.member_id = m.id),0) AS savings_cents,
              COALESCE((SELECT SUM(amount_cents) FROM fine_ledger f WHERE f.member_id = m.id),0) AS fines_outstanding_cents
         FROM members m
        WHERE ($1 = '' OR full_name ILIKE '%' || $1 || '%' OR membership_no ILIKE '%' || $1 || '%' OR phone = $2)
          AND ($3 = '' OR status = $3::member_status)
          AND (NOT $4::boolean OR NOT profile_complete)
        ORDER BY membership_no`,
      [q, normalizePhone(q), status, incomplete],
    );
    res.json(rows);
  }),
);

membersRouter.post(
  '/',
  requirePermission('members.write'),
  h(async (req, res) => {
    // "Complete later": only a name is needed; missing details are tracked as pending compliance.
    if (req.body?.completeLater === true) {
      const b = z.object({
        fullName: z.string().trim().min(2), nationalId: z.string().optional(), phone: z.string().optional(), mpesaPhone: z.string().optional(), email: z.string().optional(),
        physicalAddress: z.string().optional(), registeredOn: z.string().optional(),
      }).parse(req.body);
      const r = await withTx((c) => registerMemberLenient(c, b, actorOf(req), undefined, false));
      res.status(201).json(r);
      return;
    }
    const input = registerMemberSchema.parse(req.body);
    const result = await withTx((c) => registerMember(c, input, actorOf(req)));
    // The temporary password is shown once to the registering official to hand over.
    res.status(201).json(result);
  }),
);

membersRouter.get(
  '/finance-summary',
  requirePermission('members.read'),
  h(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT m.id, m.membership_no, m.full_name, m.status, m.profile_complete,
              COALESCE(s.contributions,0)::bigint AS contributions_cents, COALESCE(mo.n,0)::int AS months_paid,
              COALESCE(f.accrued,0)::bigint AS penalties_accrued_cents, COALESCE(f.outstanding,0)::bigint AS penalties_outstanding_cents,
              mp.last_manual_at,
              COALESCE(ob.owed,0)::bigint AS owed_contributions_cents, COALESCE(cr.bal,0)::bigint AS credit_cents
         FROM members m
         LEFT JOIN (SELECT member_id,
                           SUM(amount_cents) FILTER (WHERE type <> 'withdrawal') AS contributions,
                           0 AS months
                      FROM savings_transactions GROUP BY member_id) s ON s.member_id = m.id
         LEFT JOIN (SELECT member_id, COUNT(DISTINCT period)::int AS n FROM (
                      SELECT member_id, period FROM savings_transactions WHERE period IS NOT NULL AND type <> 'withdrawal' AND amount_cents > 0
                      UNION SELECT o.member_id, o.period FROM savings_allocations a JOIN monthly_obligations o ON o.id = a.obligation_id WHERE a.reversed_at IS NULL) u GROUP BY member_id) mo ON mo.member_id = m.id
         LEFT JOIN (SELECT member_id, SUM(amount_cents) FILTER (WHERE entry_type = 'charge') AS accrued, SUM(amount_cents) AS outstanding FROM fine_ledger GROUP BY member_id) f ON f.member_id = m.id
         LEFT JOIN (SELECT member_id, MAX(created_at) AS last_manual_at FROM manual_payments GROUP BY member_id) mp ON mp.member_id = m.id
         LEFT JOIN (SELECT member_id, SUM(amount_due_cents) AS owed FROM monthly_obligations WHERE status IN ('unpaid','overdue') GROUP BY member_id) ob ON ob.member_id = m.id
         LEFT JOIN (SELECT member_id, SUM(amount_cents) AS bal FROM member_credits GROUP BY member_id) cr ON cr.member_id = m.id
        ORDER BY m.membership_no`);
    res.json(rows);
  }),
);

membersRouter.get(
  '/:id/overview',
  requirePermission('members.read'),
  h(async (req, res) => {
    const id = String(req.params.id);
    if (!(await pool.query(`SELECT 1 FROM members WHERE id = $1`, [id])).rows[0]) throw new HttpError(404, 'Member not found');
    res.json(await memberOverview(pool, id));
  }),
);

membersRouter.get(
  '/:id',
  requirePermission('members.read'),
  h(async (req, res) => {
    const { rows } = await pool.query(`SELECT ${PUBLIC_COLUMNS}, national_id_enc, next_of_kin, emergency_contact, import_issues, imported_at, profile_completed_at FROM members WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Member not found');
    const { national_id_enc, ...member } = rows[0];
    // National ID is decrypted only for authorised officials and every view is audited.
    if (national_id_enc) await audit(pool, actorOf(req), 'member.national_id_viewed', 'member', member.id);
    res.json({ ...member, nationalId: national_id_enc ? decryptField(national_id_enc) : null, summary: await getMemberSummary(pool, member.id) });
  }),
);

const patchSchema = z.object({
  fullName: z.string().trim().min(3).optional(),
  phone: z.string().optional(),
  mpesaPhone: z.string().optional(),
  email: z.string().email().nullable().optional(),
  physicalAddress: z.string().nullable().optional(),
  registeredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

membersRouter.patch(
  '/:id',
  requirePermission('members.write'),
  h(async (req, res) => {
    const body = patchSchema.parse(req.body);
    const phone = body.phone ? normalizePhone(body.phone) : undefined;
    const mpesa = body.mpesaPhone ? normalizePhone(body.mpesaPhone) : undefined;
    if ((body.phone && !phone) || (body.mpesaPhone && !mpesa)) throw new HttpError(400, 'Invalid phone number');
    const before = (await pool.query(`SELECT full_name, phone, mpesa_phone, email, physical_address, registered_on::text AS registered_on FROM members WHERE id = $1`, [req.params.id])).rows[0];
    if (!before) throw new HttpError(404, 'Member not found');
    await pool.query(
      `UPDATE members SET full_name = COALESCE($2, full_name), phone = COALESCE($3, phone), mpesa_phone = COALESCE($4, mpesa_phone),
              email = CASE WHEN $5::boolean THEN $6 ELSE email END,
              physical_address = CASE WHEN $7::boolean THEN $8 ELSE physical_address END, registered_on = COALESCE($9::date, registered_on), updated_at = now()
        WHERE id = $1`,
      [req.params.id, body.fullName ?? null, phone ?? null, mpesa ?? null,
       body.email !== undefined, body.email ?? null, body.physicalAddress !== undefined, body.physicalAddress ?? null, body.registeredOn ?? null],
    );
    await audit(pool, actorOf(req), 'member.updated', 'member', String(req.params.id), { before, after: body });
    res.json({ ok: true });
  }),
);

membersRouter.post(
  '/:id/status',
  requirePermission('members.status'),
  h(async (req, res) => {
    const { status, reason } = z
      .object({ status: z.enum(['active', 'suspended', 'withdrawn', 'deceased']), reason: z.string().trim().min(3) })
      .parse(req.body);
    await withTx((c) => setMemberStatus(c, String(req.params.id), status, reason, actorOf(req)));
    res.json({ ok: true });
  }),
);

membersRouter.post(
  '/:id/complete-profile',
  requirePermission('members.write'),
  h(async (req, res) => {
    const input = completeProfileSchema.parse(req.body);
    if (!Object.values(input).some((v) => v !== undefined)) throw new HttpError(400, 'Enter at least one detail to add');
    res.json(await withTx((c) => completeMemberProfile(c, String(req.params.id), input, actorOf(req))));
  }),
);

// ---- Next of Kin & Beneficiary Nomination Form (read by officials; submitted for a member or amended only by the administrator)
membersRouter.get('/:id/next-of-kin', requirePermission('members.read'), h(async (req, res) => res.json(await getNok(pool, String(req.params.id), true))));
membersRouter.get('/:id/next-of-kin/pdf', requirePermission('members.read'), h(async (req, res) => {
  const id = String(req.params.id);
  const pdf = await nokPdf(pool, id);
  const m = (await pool.query(`SELECT membership_no FROM members WHERE id = $1`, [id])).rows[0];
  await audit(pool, actorOf(req), 'member.next_of_kin_downloaded', 'member', id);
  res.setHeader('content-type', 'application/pdf'); res.setHeader('content-disposition', `attachment; filename="next-of-kin-${m.membership_no}.pdf"`);
  res.send(pdf);
}));
membersRouter.post('/:id/next-of-kin', requirePermission('records.correct'), h(async (req, res) => {
  await withTx((c) => submitNok(c, String(req.params.id), req.body, actorOf(req), 'administrator'));
  res.status(201).json(await getNok(pool, String(req.params.id), true));
}));
membersRouter.put('/:id/next-of-kin', requirePermission('records.correct'), h(async (req, res) => {
  const { note, ...form } = req.body ?? {};
  await withTx((c) => amendNok(c, String(req.params.id), form, String(note ?? ''), actorOf(req)));
  res.json(await getNok(pool, String(req.params.id), true));
}));

// ---- Photo and identity card images (officials can add or replace; members can only add what is missing)
membersRouter.get('/:id/documents', requirePermission('members.read'), h(async (req, res) => res.json(await getDocs(pool, String(req.params.id)))));
membersRouter.put('/:id/documents/:kind', requirePermission('members.write'), h(async (req, res) => {
  const id = String(req.params.id); const kind = docKind(req.params.kind);
  const file = uploadSchema.parse(req.body);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimeType)) throw new HttpError(400, 'Please upload an image (JPEG, PNG or WebP)');
  const fileId = await storeFile(file, req.user!.id);
  await setDoc(pool, id, kind, fileId, actorOf(req), true);
  res.json(await getDocs(pool, id));
}));
membersRouter.delete('/:id/documents/:kind', requirePermission('records.correct'), h(async (req, res) => {
  await setDoc(pool, String(req.params.id), docKind(req.params.kind), null, actorOf(req), true);
  res.json(await getDocs(pool, String(req.params.id)));
}));

import type pg from 'pg';
import { audit, type Actor } from '../lib/audit.js';
import { dmyTimeEAT } from '../lib/dates.js';
import { HttpError } from '../lib/http.js';
import { imposeFine, lockMember, resolveFine } from './ledger.js';
import { autoFinePolicy, autoFinesApply, ensureFinancialYear, ruleAt, todayEAT } from './obligations.js';
import { notifyMany, notifyMember } from './notifications.js';

type Client = pg.PoolClient;
const kes = (c: number) => `KSh ${(c / 100).toLocaleString('en-KE')}`;

// ================================================================ meetings & attendance

export async function createMeeting(
  client: Client,
  input: { title: string; scheduledAt: string; venue: string; agenda?: string },
  actor: Actor,
): Promise<string> {
  const date = input.scheduledAt.slice(0, 10);
  const fyId = await ensureFinancialYear(client, date);
  const rule = await ruleAt(client, date);
  const count = (
    await client.query(`SELECT count(*)::int AS n FROM meetings WHERE financial_year_id = $1 AND status <> 'cancelled'`, [fyId])
  ).rows[0].n;
  if (count >= rule.meetings_per_year) {
    throw new HttpError(409, `This financial year already has its ${rule.meetings_per_year} mandatory meetings. Cancel one or change the group rules first.`);
  }
  const { rows } = await client.query(
    `INSERT INTO meetings (financial_year_id, title, scheduled_at, venue, agenda, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [fyId, input.title, input.scheduledAt, input.venue, input.agenda ?? null, actor.userId],
  );
  const id: string = rows[0].id;
  await client.query(
    `INSERT INTO attendance (meeting_id, member_id) SELECT $1, id FROM members WHERE status = 'active' ON CONFLICT DO NOTHING`,
    [id],
  );
  await audit(client, actor, 'meeting.created', 'meeting', id, { after: input });
  const when = dmyTimeEAT(input.scheduledAt);
  await notifyMany(client, null, 'meeting_invite', `Meeting: ${input.title}`, `You are invited to "${input.title}" on ${when} at ${input.venue}. Attendance is mandatory; unexcused absence attracts a fine.`, true, `meeting:${id}`);
  return id;
}

export async function cancelMeeting(client: Client, meetingId: string, reason: string, actor: Actor) {
  const { rows } = await client.query(`SELECT status FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId]);
  if (!rows[0]) throw new HttpError(404, 'Meeting not found');
  if (rows[0].status === 'register_confirmed') throw new HttpError(409, 'A meeting with a confirmed register cannot be cancelled');
  await client.query(`UPDATE meetings SET status = 'cancelled' WHERE id = $1`, [meetingId]);
  await audit(client, actor, 'meeting.cancelled', 'meeting', meetingId, { reason });
}

export async function submitApology(client: Client, meetingId: string, memberId: string, reason: string) {
  const m = (await client.query(`SELECT status, scheduled_at FROM meetings WHERE id = $1`, [meetingId])).rows[0];
  if (!m) throw new HttpError(404, 'Meeting not found');
  if (m.status === 'register_confirmed' || m.status === 'cancelled') throw new HttpError(409, 'Apologies are closed for this meeting');
  await client.query(
    `INSERT INTO attendance (meeting_id, member_id, apology_reason, apology_reviewed) VALUES ($1,$2,$3,false)
     ON CONFLICT (meeting_id, member_id) DO UPDATE SET apology_reason = EXCLUDED.apology_reason, apology_reviewed = false, updated_at = now()`,
    [meetingId, memberId, reason],
  );
}

export async function setAttendance(
  client: Client,
  meetingId: string,
  entries: { memberId: string; status: 'pending' | 'present' | 'absent' | 'excused' }[],
  actor: Actor,
) {
  const m = (await client.query(`SELECT status FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId])).rows[0];
  if (!m) throw new HttpError(404, 'Meeting not found');
  if (m.status === 'register_confirmed') throw new HttpError(409, 'The register is confirmed. Use an amendment with a reason.');
  if (m.status === 'cancelled') throw new HttpError(409, 'Meeting is cancelled');
  for (const e of entries) {
    await client.query(
      `INSERT INTO attendance (meeting_id, member_id, status, updated_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (meeting_id, member_id) DO UPDATE
         SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now(),
             apology_reviewed = CASE WHEN EXCLUDED.status = 'excused' THEN true ELSE attendance.apology_reviewed END`,
      [meetingId, e.memberId, e.status, actor.userId],
    );
  }
  await client.query(`UPDATE meetings SET status = 'held' WHERE id = $1 AND status = 'scheduled'`, [meetingId]);
  await audit(client, actor, 'attendance.recorded', 'meeting', meetingId, { after: { count: entries.length } });
}

/** Approve (excused) or reject (absent, fine applies) a submitted apology. */
export async function reviewApology(client: Client, meetingId: string, memberId: string, approve: boolean, actor: Actor) {
  const { rowCount } = await client.query(
    `UPDATE attendance SET status = $3, apology_reviewed = true, updated_by = $4, updated_at = now()
      WHERE meeting_id = $1 AND member_id = $2 AND apology_reason IS NOT NULL
        AND EXISTS (SELECT 1 FROM meetings WHERE id = $1 AND status NOT IN ('register_confirmed','cancelled'))`,
    [meetingId, memberId, approve ? 'excused' : 'absent', actor.userId],
  );
  if (!rowCount) throw new HttpError(404, 'No open apology found');
  await audit(client, actor, approve ? 'apology.approved' : 'apology.rejected', 'meeting', meetingId, { after: { memberId } });
}

/**
 * Confirm the attendance register. Only now does absence become chargeable: every unexcused absentee
 * gets exactly one absence fine; excused members never do. Nothing may remain Pending.
 */
export async function confirmRegister(client: Client, meetingId: string, actor: Actor) {
  const m = (await client.query(`SELECT * FROM meetings WHERE id = $1 FOR UPDATE`, [meetingId])).rows[0];
  if (!m) throw new HttpError(404, 'Meeting not found');
  if (m.status === 'register_confirmed') throw new HttpError(409, 'Register already confirmed');
  if (m.status === 'cancelled') throw new HttpError(409, 'Meeting is cancelled');

  // Members who joined after the invitation still need a row.
  await client.query(
    `INSERT INTO attendance (meeting_id, member_id)
     SELECT $1, id FROM members WHERE status = 'active' AND registered_on <= ($2::timestamptz AT TIME ZONE 'Africa/Nairobi')::date
     ON CONFLICT DO NOTHING`,
    [meetingId, m.scheduled_at],
  );
  const pending = (await client.query(`SELECT count(*)::int AS n FROM attendance WHERE meeting_id = $1 AND status = 'pending'`, [meetingId])).rows[0].n;
  if (pending > 0) throw new HttpError(409, `${pending} member(s) are still Pending Confirmation. Mark each Present, Absent or Excused first.`);
  const unreviewed = (
    await client.query(`SELECT count(*)::int AS n FROM attendance WHERE meeting_id = $1 AND apology_reason IS NOT NULL AND NOT apology_reviewed AND status = 'absent'`, [meetingId])
  ).rows[0].n;
  if (unreviewed > 0) throw new HttpError(409, `${unreviewed} submitted apolog${unreviewed === 1 ? 'y has' : 'ies have'} not been reviewed yet.`);

  const meetingDate = (await client.query(`SELECT ($1::timestamptz AT TIME ZONE 'Africa/Nairobi')::date AS d`, [m.scheduled_at])).rows[0].d;
  const rule = await ruleAt(client, meetingDate);
  const absentees = (await client.query(`SELECT member_id FROM attendance WHERE meeting_id = $1 AND status = 'absent'`, [meetingId])).rows;
  const finesOn = autoFinesApply(await autoFinePolicy(client), String(meetingDate).slice(0, 10));
  let fined = 0;
  for (const a of absentees) {
    if (!finesOn) break;
    const exists = await client.query(`SELECT 1 FROM fines WHERE meeting_id = $1 AND member_id = $2 AND category = 'absence' AND status <> 'reversed'`, [meetingId, a.member_id]);
    if (exists.rows[0] || rule.absence_fine_cents <= 0) continue;
    await imposeFine(client, { memberId: a.member_id, category: 'absence', amountCents: rule.absence_fine_cents, reason: `Unexcused absence: ${m.title}`, meetingId }, actor);
    await notifyMember(client, a.member_id, 'fine', 'Absence fine', `You were recorded absent from "${m.title}". A fine of ${kes(rule.absence_fine_cents)} applies. Pay it separately from your savings.`, true, `absence:${meetingId}`);
    fined++;
  }
  await client.query(`UPDATE meetings SET status = 'register_confirmed', register_confirmed_at = now(), register_confirmed_by = $2 WHERE id = $1`, [meetingId, actor.userId]);
  await audit(client, actor, 'meeting.register_confirmed', 'meeting', meetingId, { after: { fined, absentees: absentees.length } });
  return { fined };
}

/** Post-confirmation correction. Wrongly-fined members have the fine reversed (never deleted). */
export async function amendAttendance(
  client: Client,
  meetingId: string,
  memberId: string,
  status: 'present' | 'absent' | 'excused',
  reason: string,
  actor: Actor,
) {
  if (!reason.trim()) throw new HttpError(400, 'A reason is required');
  const m = (await client.query(`SELECT * FROM meetings WHERE id = $1`, [meetingId])).rows[0];
  if (!m || m.status !== 'register_confirmed') throw new HttpError(409, 'Only confirmed registers need amendments');
  const prev = (await client.query(`SELECT status FROM attendance WHERE meeting_id = $1 AND member_id = $2 FOR UPDATE`, [meetingId, memberId])).rows[0]?.status;
  if (prev === status) return;
  if (prev === 'absent' && status !== 'absent') {
    const fine = (await client.query(`SELECT id, status FROM fines WHERE meeting_id = $1 AND member_id = $2 AND category = 'absence' AND status <> 'reversed'`, [meetingId, memberId])).rows[0];
    if (fine) {
      if (fine.status === 'paid') throw new HttpError(409, 'The absence fine was already paid. Reverse that payment first.');
      if (fine.status === 'outstanding') await resolveFine(client, fine.id, 'reversal', `Attendance amended: ${reason}`, actor);
    }
  }
  if (status === 'absent' && autoFinesApply(await autoFinePolicy(client), String((await client.query(`SELECT ($1::timestamptz AT TIME ZONE 'Africa/Nairobi')::date AS d`, [m.scheduled_at])).rows[0].d).slice(0, 10))) {
    const rule = await ruleAt(client, await todayEAT(client));
    await imposeFine(client, { memberId, category: 'absence', amountCents: rule.absence_fine_cents, reason: `Unexcused absence: ${m.title}`, meetingId }, actor);
  }
  await client.query(
    `INSERT INTO attendance (meeting_id, member_id, status, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (meeting_id, member_id) DO UPDATE SET status = EXCLUDED.status, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [meetingId, memberId, status, actor.userId],
  );
  await audit(client, actor, 'attendance.amended', 'meeting', meetingId, { reason, before: { status: prev }, after: { memberId, status } });
}

// ================================================================ withdrawals

export async function requestWithdrawal(client: Client, memberId: string, amountCents: number, reason: string, actor: Actor) {
  await lockMember(client, memberId);
  const member = (await client.query(`SELECT status, profile_complete FROM members WHERE id = $1`, [memberId])).rows[0];
  if (member.status !== 'active') throw new HttpError(409, 'Only active members can request a withdrawal');
  if (!member.profile_complete) throw new HttpError(409, 'Your profile is not compliant yet. Complete and submit your Next of Kin form (and have your National ID and phone number on file) before a withdrawal can be requested.', 'PROFILE_INCOMPLETE');
  const balance = (await client.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE member_id = $1`, [memberId])).rows[0].b;
  const open = (await client.query(`SELECT reference FROM withdrawals WHERE member_id = $1 AND status IN ('submitted','in_review','approved')`, [memberId])).rows[0];
  if (open) throw new HttpError(409, `You already have an open withdrawal request (${open.reference}). Wait for it to be completed.`);
  const min = Number((await client.query(`SELECT value FROM system_settings WHERE key = 'withdrawal_min_cents'`)).rows[0]?.value ?? 0);
  if (amountCents < min) throw new HttpError(400, `The minimum withdrawal is ${kes(min)}`);
  if (amountCents > balance) throw new HttpError(409, `Requested ${kes(amountCents)} exceeds your savings balance of ${kes(balance)}. Fines are not deducted from savings.`);
  const levels = ((await client.query(`SELECT value FROM system_settings WHERE key = 'withdrawal_approval_levels'`)).rows[0]?.value ?? ['treasurer', 'chairperson']) as string[];
  const { rows } = await client.query(
    `INSERT INTO withdrawals (reference, member_id, amount_cents, reason, required_levels, balance_at_request)
     VALUES ('WD-' || lpad(nextval('withdrawal_ref_seq')::text, 5, '0'), $1,$2,$3,$4,$5) RETURNING id, reference`,
    [memberId, amountCents, reason, levels, balance],
  );
  await audit(client, actor, 'withdrawal.requested', 'withdrawal', rows[0].id, { after: { amountCents, reason, balance } });
  await notifyMember(client, memberId, 'withdrawal', 'Withdrawal request received', `Request ${rows[0].reference} for ${kes(amountCents)} was submitted for review.`);
  return rows[0] as { id: string; reference: string };
}

export async function cancelWithdrawal(client: Client, id: string, memberId: string, actor: Actor) {
  const w = (await client.query(`SELECT * FROM withdrawals WHERE id = $1 AND member_id = $2 FOR UPDATE`, [id, memberId])).rows[0];
  if (!w) throw new HttpError(404, 'Request not found');
  if (!['submitted', 'in_review'].includes(w.status)) throw new HttpError(409, 'This request can no longer be cancelled');
  await client.query(`UPDATE withdrawals SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
  await audit(client, actor, 'withdrawal.cancelled', 'withdrawal', id);
}

export async function decideWithdrawal(
  client: Client,
  id: string,
  decision: 'approved' | 'rejected',
  reason: string | null,
  actor: Actor & { userId: string; role: string },
) {
  const w = (await client.query(`SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!w) throw new HttpError(404, 'Request not found');
  if (!['submitted', 'in_review'].includes(w.status)) throw new HttpError(409, `This request is already ${w.status}`);
  const requiredRole = w.required_levels[w.current_level - 1] as string;
  if (actor.role !== requiredRole && actor.role !== 'super_admin') {
    throw new HttpError(403, `This step needs approval from the ${requiredRole}`);
  }
  const prior = await client.query(`SELECT 1 FROM withdrawal_approvals WHERE withdrawal_id = $1 AND decided_by = $2`, [id, actor.userId]);
  if (prior.rows[0]) throw new HttpError(409, 'The same person cannot decide more than one approval level');
  if (decision === 'rejected' && !reason?.trim()) throw new HttpError(400, 'A reason is required to reject');
  await client.query(
    `INSERT INTO withdrawal_approvals (withdrawal_id, level, role, decision, reason, decided_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, w.current_level, requiredRole, decision, reason, actor.userId],
  );
  let status: string;
  if (decision === 'rejected') status = 'rejected';
  else if (w.current_level >= w.required_levels.length) status = 'approved';
  else status = 'in_review';
  await client.query(
    `UPDATE withdrawals SET status = $2, current_level = CASE WHEN $2 = 'in_review' THEN current_level + 1 ELSE current_level END, updated_at = now() WHERE id = $1`,
    [id, status],
  );
  await audit(client, actor, `withdrawal.${decision}`, 'withdrawal', id, { reason, after: { level: w.current_level, status } });
  if (status === 'approved' || status === 'rejected') {
    await notifyMember(client, w.member_id, 'withdrawal', `Withdrawal ${status}`,
      status === 'approved' ? `Request ${w.reference} for ${kes(w.amount_cents)} is approved. Payment will follow.` : `Request ${w.reference} was not approved.${reason ? ' Reason: ' + reason : ''}`, true);
  }
  return status;
}

/**
 * Records that the approved amount was actually paid out. Only now does the savings ledger drop.
 * The balance is re-checked under the member lock, and the payout reference must be unique.
 */
export async function recordWithdrawalPayout(client: Client, id: string, payoutReference: string, actor: Actor) {
  const w0 = (await client.query(`SELECT member_id FROM withdrawals WHERE id = $1`, [id])).rows[0];
  if (!w0) throw new HttpError(404, 'Request not found');
  await lockMember(client, w0.member_id);
  const w = (await client.query(`SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (w.status !== 'approved') throw new HttpError(409, w.status === 'paid' ? 'This withdrawal has already been paid' : 'Only fully approved withdrawals can be paid');
  const balance = (await client.query(`SELECT COALESCE(SUM(amount_cents),0) AS b FROM savings_transactions WHERE member_id = $1`, [w.member_id])).rows[0].b;
  if (balance < w.amount_cents) throw new HttpError(409, 'The member no longer has enough savings for this withdrawal');
  const txn = await client.query(
    `INSERT INTO savings_transactions (member_id, type, amount_cents, reference, reason, created_by)
     VALUES ($1,'withdrawal',$2,$3,$4,$5) RETURNING id`,
    [w.member_id, -w.amount_cents, payoutReference, `Withdrawal ${w.reference}`, actor.userId],
  );
  await client.query(
    `UPDATE withdrawals SET status = 'paid', payout_reference = $2, paid_at = now(), paid_by = $3, savings_txn_id = $4, updated_at = now() WHERE id = $1`,
    [id, payoutReference, actor.userId, txn.rows[0].id],
  );
  await audit(client, actor, 'withdrawal.paid', 'withdrawal', id, { after: { payoutReference, amountCents: w.amount_cents } });
  await notifyMember(client, w.member_id, 'withdrawal', 'Withdrawal paid', `${kes(w.amount_cents)} was paid out (ref ${payoutReference}). It has been deducted from your savings.`, true);
}

// ================================================================ group income & expenditure

export async function recordIncome(
  client: Client,
  input: { category: 'special_contribution' | 'other_income' | 'opening_balance' | 'adjustment'; amountCents: number; receivedOn: string; description: string; source?: string; reference?: string },
  actor: Actor,
): Promise<string> {
  const { rows } = await client.query(
    `INSERT INTO income (category, amount_cents, received_on, description, source, reference, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [input.category, input.amountCents, input.receivedOn, input.description, input.source ?? null, input.reference ?? null, actor.userId],
  );
  await audit(client, actor, 'income.recorded', 'income', rows[0].id, { after: input });
  return rows[0].id;
}

export async function reverseIncome(client: Client, id: string, reason: string, actor: Actor) {
  const o = (await client.query(`SELECT * FROM income WHERE id = $1`, [id])).rows[0];
  if (!o) throw new HttpError(404, 'Income entry not found');
  if (o.amount_cents < 0) throw new HttpError(409, 'A reversal cannot be reversed');
  const today = await todayEAT(client);
  await client.query(
    `INSERT INTO income (category, amount_cents, received_on, description, reverses_id, recorded_by) VALUES ('adjustment',$1,$2,$3,$4,$5)`,
    [-o.amount_cents, today, `Reversal: ${reason}`, id, actor.userId],
  );
  await audit(client, actor, 'income.reversed', 'income', id, { reason });
}

export async function requestExpenditure(
  client: Client,
  input: { category: 'administrative' | 'meeting' | 'other'; amountCents: number; spentOn: string; description: string; recipient: string; meetingId?: string; supportingFileId?: string },
  actor: Actor & { userId: string },
): Promise<{ id: string; reference: string }> {
  const { rows } = await client.query(
    `INSERT INTO expenditure (reference, category, amount_cents, spent_on, description, recipient, meeting_id, supporting_file_id, requested_by)
     VALUES ('EX-' || lpad(nextval('expenditure_ref_seq')::text, 5, '0'), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, reference`,
    [input.category, input.amountCents, input.spentOn, input.description, input.recipient, input.meetingId ?? null, input.supportingFileId ?? null, actor.userId],
  );
  await audit(client, actor, 'expenditure.requested', 'expenditure', rows[0].id, { after: input });
  return rows[0];
}

export async function decideExpenditure(client: Client, id: string, approve: boolean, note: string | null, actor: Actor & { userId: string }) {
  const e = (await client.query(`SELECT * FROM expenditure WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!e) throw new HttpError(404, 'Expenditure not found');
  if (e.status !== 'pending') throw new HttpError(409, `Already ${e.status}`);
  if (e.requested_by === actor.userId && actor.role !== 'super_admin') throw new HttpError(403, 'You cannot approve your own expenditure request');
  if (approve && !e.supporting_file_id) throw new HttpError(409, 'Attach supporting documentation (receipt/invoice) before approval');
  if (!approve && !note?.trim()) throw new HttpError(400, 'A reason is required to reject');
  await client.query(
    `UPDATE expenditure SET status = $2, approved_by = $3, approved_at = now(), void_reason = CASE WHEN $2 = 'rejected' THEN $4 ELSE void_reason END WHERE id = $1`,
    [id, approve ? 'approved' : 'rejected', actor.userId, note],
  );
  await audit(client, actor, approve ? 'expenditure.approved' : 'expenditure.rejected', 'expenditure', id, { reason: note });
}

export async function payExpenditure(client: Client, id: string, paymentReference: string, actor: Actor) {
  const e = (await client.query(`SELECT status FROM expenditure WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!e) throw new HttpError(404, 'Expenditure not found');
  if (e.status !== 'approved') throw new HttpError(409, 'Only approved expenditure can be paid');
  await client.query(`UPDATE expenditure SET status = 'paid', payment_reference = $2, paid_at = now() WHERE id = $1`, [id, paymentReference]);
  await audit(client, actor, 'expenditure.paid', 'expenditure', id, { after: { paymentReference } });
}

export async function voidExpenditure(client: Client, id: string, reason: string, actor: Actor) {
  if (!reason.trim()) throw new HttpError(400, 'A reason is required');
  const e = (await client.query(`SELECT status FROM expenditure WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!e) throw new HttpError(404, 'Expenditure not found');
  if (e.status === 'voided') throw new HttpError(409, 'Already voided');
  await client.query(`UPDATE expenditure SET status = 'voided', void_reason = $2 WHERE id = $1`, [id, reason]);
  await audit(client, actor, 'expenditure.voided', 'expenditure', id, { reason, before: { status: e.status } });
}

// ================================================================ M-Pesa message verification queue

import { confirmPayment } from './ledger.js';
import { normalizePhone } from '../lib/phone.js';

export async function submitPaymentProof(
  client: Client,
  memberId: string,
  input: { mpesaCode: string; amountCents: number; phone: string; paidAt: string; purpose: 'savings' | 'fine'; fineIds?: string[]; messageText?: string; screenshotId?: string },
  actor: Actor,
) {
  const code = input.mpesaCode.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,12}$/.test(code)) throw new HttpError(400, 'Enter the M-Pesa transaction code exactly as it appears in the message');
  const phone = normalizePhone(input.phone);
  if (!phone) throw new HttpError(400, 'Enter a valid Kenyan mobile number');
  const recorded = await client.query(`SELECT id FROM payments WHERE mpesa_receipt = $1`, [code]);
  if (recorded.rows[0]) throw new HttpError(409, 'This M-Pesa transaction is already recorded in the system', 'DUPLICATE_RECEIPT');
  const { rows } = await client.query(
    `INSERT INTO payment_submissions (member_id, mpesa_code, amount_cents, phone, paid_at, purpose, fine_ids, message_text, screenshot_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [memberId, code, input.amountCents, phone, input.paidAt, input.purpose, input.fineIds ?? null, input.messageText ?? null, input.screenshotId ?? null],
  );
  await client.query(`INSERT INTO submission_events (submission_id, event, actor_id) VALUES ($1,'submitted',$2)`, [rows[0].id, actor.userId]);
  await audit(client, actor, 'submission.created', 'submission', rows[0].id, { after: { code, amountCents: input.amountCents } });
  return rows[0].id as string;
}

/** A screenshot or SMS never confirms anything by itself; the treasurer must verify against official records. */
export async function reviewSubmission(
  client: Client,
  id: string,
  action: 'approve' | 'reject' | 'clarify',
  note: string | null,
  verifiedAgainstOfficialRecords: boolean,
  actor: Actor,
) {
  const s = (await client.query(`SELECT * FROM payment_submissions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!s) throw new HttpError(404, 'Submission not found');
  if (!['pending', 'clarification'].includes(s.status)) throw new HttpError(409, `This submission is already ${s.status}`);

  if (action !== 'approve' && !note?.trim()) throw new HttpError(400, 'A note is required');
  if (action === 'approve') {
    if (!verifiedAgainstOfficialRecords) throw new HttpError(400, 'Confirm that you verified this transaction against the official M-Pesa records');
    const dup = await client.query(`SELECT id FROM payments WHERE mpesa_receipt = $1`, [s.mpesa_code]);
    if (dup.rows[0]) throw new HttpError(409, 'This M-Pesa transaction is already recorded', 'DUPLICATE_RECEIPT');
    const p = await client.query(
      `INSERT INTO payments (member_id, purpose, channel, amount_cents, phone, status, mpesa_receipt, fine_ids, occurred_at, created_by)
       VALUES ($1,$2,'manual',$3,$4,'initiated',$5,$6,$7,$8) RETURNING id`,
      [s.member_id, s.purpose, s.amount_cents, s.phone, s.mpesa_code, s.fine_ids, s.paid_at, actor.userId],
    );
    const outcome = await confirmPayment(client, p.rows[0].id, actor);
    await client.query(`UPDATE payment_submissions SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3, payment_id = $4 WHERE id = $1`, [id, actor.userId, note, p.rows[0].id]);
    await client.query(`INSERT INTO submission_events (submission_id, event, note, actor_id) VALUES ($1,'approved',$2,$3)`, [id, note, actor.userId]);
    await audit(client, actor, 'submission.approved', 'submission', id, { after: { outcome: outcome.outcome } });
    if (outcome.outcome === 'confirmed' || outcome.outcome === 'fines_paid') {
      await notifyMember(client, s.member_id, 'payment_confirmed', 'Payment verified', `Your M-Pesa payment ${s.mpesa_code} was verified. Receipt ${outcome.receiptNo}.`, true);
    } else if (outcome.outcome === 'held') {
      await notifyMember(client, s.member_id, 'payment_held', 'Payment needs attention', outcome.reason);
    }
    return outcome;
  }
  const status = action === 'reject' ? 'rejected' : 'clarification';
  await client.query(`UPDATE payment_submissions SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`, [id, status, actor.userId, note]);
  await client.query(`INSERT INTO submission_events (submission_id, event, note, actor_id) VALUES ($1,$2,$3,$4)`, [id, status, note, actor.userId]);
  await audit(client, actor, `submission.${status}`, 'submission', id, { reason: note });
  await notifyMember(client, s.member_id, 'submission', action === 'reject' ? 'Payment submission rejected' : 'More information needed', note!, false);
  return null;
}

export async function respondToClarification(client: Client, id: string, memberId: string, message: string, actor: Actor) {
  const s = (await client.query(`SELECT status FROM payment_submissions WHERE id = $1 AND member_id = $2 FOR UPDATE`, [id, memberId])).rows[0];
  if (!s) throw new HttpError(404, 'Submission not found');
  if (s.status !== 'clarification') throw new HttpError(409, 'No clarification was requested');
  await client.query(`UPDATE payment_submissions SET status = 'pending', message_text = COALESCE(message_text,'') || E'\\n[Member reply] ' || $2 WHERE id = $1`, [id, message]);
  await client.query(`INSERT INTO submission_events (submission_id, event, note, actor_id) VALUES ($1,'member_replied',$2,$3)`, [id, message, actor.userId]);
}
